import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import App from './App';

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal('alert', vi.fn());
    (window as any).YT = {
      Player: vi.fn().mockImplementation((_id: string, options?: any) => {
        if (options?.events?.onReady) {
          options.events.onReady();
        }

        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
        };
      }),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the current input and viewer shell', () => {
    render(<App />);

    expect(screen.getByPlaceholderText(/type text to sign/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste youtube link/i)).toBeInTheDocument();
    expect(screen.getByRole('button', {name: /submit/i})).toBeInTheDocument();
    expect(screen.getByLabelText(/stick figure output panel/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/video preview panel/i)).not.toBeInTheDocument();
  });

  it('signs manually typed text without showing the video panel', async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.type(screen.getByPlaceholderText(/type text to sign/i), 'Hello world');
    await user.click(screen.getByRole('button', {name: /submit/i}));

    await waitFor(() => {
      const poseViewer = document.querySelector('pose-viewer');
      const src = poseViewer?.getAttribute('src') ?? '';
      expect(src).toContain('https://us-central1-sign-mt.cloudfunctions.net/spoken_text_to_signed_pose?');
      expect(src).toContain('text=Hello+world');
      expect(src).toContain('spoken=en');
      expect(src).toContain('signed=ase');
    });

    expect(screen.queryByLabelText(/video preview panel/i)).not.toBeInTheDocument();
    expect(screen.getByText(/now signing/i)).toBeInTheDocument();
    expect(screen.getByText('Hello world', {selector: '.viewer-caption-text'})).toBeInTheDocument();
  });

  it('loads subtitles from backend and shows the video panel for youtube links', async () => {
    const user = userEvent.setup();
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
          text: async () => `1\n00:00:00,000 --> 00:00:01,000\nHello world\n`,
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch url: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await user.type(screen.getByPlaceholderText(/paste youtube link/i), 'https://www.youtube.com/watch?v=abc123');
    await user.click(screen.getByRole('button', {name: /submit/i}));

    await waitFor(() => {
      expect(screen.getByLabelText(/video preview panel/i)).toBeInTheDocument();
      const poseViewer = document.querySelector('pose-viewer');
      const src = poseViewer?.getAttribute('src') ?? '';
      expect(src).toContain('https://us-central1-sign-mt.cloudfunctions.net/spoken_text_to_signed_pose?');
      expect(src).toContain('text=Hello+world');
      expect(src).toContain('spoken=en');
      expect(src).toContain('signed=ase');
    });

    expect(fetchMock).toHaveBeenCalled();
  });
});

