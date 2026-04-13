import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import App from './App';

type MockPlayer = {
  currentTime: number;
  destroy: ReturnType<typeof vi.fn>;
  getCurrentTime: ReturnType<typeof vi.fn>;
  pauseVideo: ReturnType<typeof vi.fn>;
  playVideo: ReturnType<typeof vi.fn>;
  seekTo: ReturnType<typeof vi.fn>;
};

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('App', () => {
  let players: MockPlayer[];

  beforeEach(() => {
    players = [];
    window.localStorage.clear();
    document.documentElement.dataset.theme = 'light';
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 16)
    );
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      window.clearTimeout(handle);
    });
    (window as typeof window & {YT?: unknown}).YT = {
      Player: vi.fn().mockImplementation((_id: string, options?: any) => {
        const player: MockPlayer = {
          currentTime: 0,
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => player.currentTime),
          pauseVideo: vi.fn(),
          playVideo: vi.fn(() => {
            player.currentTime += 60;
          }),
          seekTo: vi.fn((time: number) => {
            player.currentTime = time;
          }),
        };

        players.push(player);

        if (options?.events?.onReady) {
          options.events.onReady();
        }

        return player;
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the current input shell and transcript panel', async () => {
    render(<App />);

    expect(screen.getByPlaceholderText(/enter a youtube url/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/enter text for translation/i)).not.toBeInTheDocument();
    expect(screen.getByRole('tab', {name: /youtube url/i})).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', {name: /text/i})).toBeInTheDocument();
    expect(screen.getByRole('tab', {name: /subtitle file/i})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: /submit/i})).toBeInTheDocument();
    expect(screen.getByLabelText(/stick figure output panel/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/video preview panel/i)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Avatar Preview')).toBeInTheDocument();
    });
  });

  it('opens the workspace menu and toggles the theme', async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(document.documentElement.dataset.theme).toBe('light');

    await user.click(screen.getByRole('button', {name: /open workspace menu/i}));
    expect(screen.getByRole('menu', {name: /workspace menu/i})).toBeInTheDocument();
    expect(screen.getByRole('menuitem', {name: /toggle theme/i})).toBeInTheDocument();
    expect(screen.getByRole('menuitem', {name: /our team/i})).toBeDisabled();

    await user.click(screen.getByRole('menuitem', {name: /toggle theme/i}));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('routes manual text into a single visible playback chunk without showing the video panel', async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole('tab', {name: /text/i}));
    await user.type(screen.getByPlaceholderText(/enter text for translation/i), 'Hello world');
    await user.click(screen.getByRole('button', {name: /submit/i}));

    await waitFor(() => {
      const poseViewers = Array.from(document.querySelectorAll('pose-viewer'));
      expect(poseViewers).toHaveLength(1);
      expect(poseViewers[0]?.getAttribute('src')).toContain('text=Hello+world');
    });

    expect(screen.queryByLabelText(/video preview panel/i)).not.toBeInTheDocument();
    expect(screen.getByText('Avatar Preview')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /show chunks/i})).not.toBeInTheDocument();
  });

  it('loads each youtube chunk through the same visible-viewer path', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/download?url=')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            video_id: 'abc123',
            subtitle_url: '/downloads/test.en.srt',
          }),
        } as Response);
      }

      if (url.includes('/downloads/test.en.srt')) {
        return Promise.resolve({
          ok: true,
          text: async () => `1
00:00:00,000 --> 00:00:00,700
This is

2
00:00:00,720 --> 00:00:01,500
chunk one.

3
00:00:03,000 --> 00:00:04,000
Chunk two starts later
`,
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch url: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText(/enter a youtube url/i), {
      target: {value: 'https://www.youtube.com/watch?v=abc123'},
    });
    fireEvent.click(screen.getByRole('button', {name: /submit/i}));
    await flushPromises();

    const poseViewers = Array.from(document.querySelectorAll('pose-viewer'));
    expect(screen.getByLabelText(/video preview panel/i)).toBeInTheDocument();
    expect(poseViewers).toHaveLength(1);
    expect(poseViewers[0]?.getAttribute('data-role')).toBe('visible');
    expect(players).toHaveLength(1);
    expect(players[0]?.seekTo).not.toHaveBeenCalled();

    await advance(6);
    expect(players[0]?.seekTo).not.toHaveBeenCalled();

    await advance(22);
    expect(players[0]?.seekTo).toHaveBeenCalledWith(0, true);

    fireEvent.click(screen.getByRole('button', {name: /show chunks/i}));
    expect(screen.queryByLabelText(/transcript chunks/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/current chunk text/i)).toHaveTextContent('This is chunk one.');

    await advance(110);
    expect(players[0]?.pauseVideo).toHaveBeenCalled();

    const seekCalls = players[0]?.seekTo.mock.calls ?? [];
    expect(seekCalls).toEqual(
      expect.arrayContaining([
        [0, true],
        [1.5, true],
      ])
    );

    const forcedPauseSeekIndex = seekCalls.findIndex(
      call => call[0] === 1.5 && call[1] === true
    );
    expect(forcedPauseSeekIndex).toBeGreaterThan(-1);

    await flushPromises();
    await advance(30);

    const reboundViewer = document.querySelector('pose-viewer[data-role="visible"]');
    expect(reboundViewer?.getAttribute('src')).toContain('Chunk+two+starts+later');
    expect(screen.getByLabelText(/current chunk text/i)).toHaveTextContent('Chunk two starts later');

    expect(fetchMock).toHaveBeenCalled();
  });

  it('pauses a short youtube chunk before playback can spill into the next chunk span', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/download?url=')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            video_id: 'short123',
            subtitle_url: '/downloads/short.en.srt',
          }),
        } as Response);
      }

      if (url.includes('/downloads/short.en.srt')) {
        return Promise.resolve({
          ok: true,
          text: async () => `1
00:00:00,000 --> 00:00:00,300
This chunk is short.

2
00:00:00,350 --> 00:00:00,950
Chunk two starts here
`,
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch url: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    players = [];
    (window as typeof window & {YT?: unknown}).YT = {
      Player: vi.fn().mockImplementation((_id: string, options?: any) => {
        let playbackTimer: ReturnType<typeof setInterval> | null = null;
        const player: MockPlayer = {
          currentTime: 0,
          destroy: vi.fn(() => {
            if (playbackTimer) {
              clearInterval(playbackTimer);
              playbackTimer = null;
            }
          }),
          getCurrentTime: vi.fn(() => player.currentTime),
          pauseVideo: vi.fn(() => {
            if (playbackTimer) {
              clearInterval(playbackTimer);
              playbackTimer = null;
            }
          }),
          playVideo: vi.fn(() => {
            if (playbackTimer) {
              return;
            }

            playbackTimer = setInterval(() => {
              player.currentTime += 0.05;
            }, 50);
          }),
          seekTo: vi.fn((time: number) => {
            player.currentTime = time;
          }),
        };

        players.push(player);

        if (options?.events?.onReady) {
          options.events.onReady();
        }

        return player;
      }),
    };

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText(/enter a youtube url/i), {
      target: {value: 'https://www.youtube.com/watch?v=short123'},
    });
    fireEvent.click(screen.getByRole('button', {name: /submit/i}));
    await flushPromises();

    await advance(30);
    expect(players[0]?.seekTo).toHaveBeenCalledWith(0, true);

    await advance(290);
    expect(players[0]?.pauseVideo).toHaveBeenCalled();
    expect(players[0]?.seekTo).not.toHaveBeenCalledWith(0.35, true);
    expect(players[0]?.currentTime).toBeLessThan(0.35);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('submits only the active mode even when another mode has a draft value', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/download?url=')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            video_id: 'mode123',
            subtitle_url: '/downloads/mode.en.srt',
          }),
        } as Response);
      }

      if (url.includes('/downloads/mode.en.srt')) {
        return Promise.resolve({
          ok: true,
          text: async () => `1
00:00:00,000 --> 00:00:01,000
Mode switched correctly
`,
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch url: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await user.click(screen.getByRole('tab', {name: /text/i}));
    await user.type(screen.getByPlaceholderText(/enter text for translation/i), 'Draft text');
    await user.click(screen.getByRole('tab', {name: /youtube url/i}));
    await user.type(screen.getByPlaceholderText(/enter a youtube url/i), 'https://www.youtube.com/watch?v=mode123');
    await user.click(screen.getByRole('button', {name: /submit/i}));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).toContain('/download?url=');
    expect(screen.getByLabelText(/video preview panel/i)).toBeInTheDocument();
  });
});
