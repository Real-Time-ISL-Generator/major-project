import '@testing-library/jest-dom/vitest';
import {vi} from 'vitest';

HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,mock');

vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 16)
);
vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
  window.clearTimeout(handle);
});

Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
  configurable: true,
  get() {
    return (this as HTMLMediaElement & {__srcObject?: MediaStream | null}).__srcObject ?? null;
  },
  set(value: MediaStream | null) {
    (this as HTMLMediaElement & {__srcObject?: MediaStream | null}).__srcObject = value;
  },
});

class MockMediaStreamTrack {
  enabled = true;
  readyState: 'live' | 'ended' = 'live';

  constructor(
    public kind: 'audio' | 'video',
    public id: string
  ) {}

  stop() {
    this.readyState = 'ended';
  }
}

class MockMediaStream {
  private audioTracks: MockMediaStreamTrack[];
  private videoTracks: MockMediaStreamTrack[];

  constructor({audio = true, video = true}: {audio?: boolean; video?: boolean} = {}) {
    this.audioTracks = audio ? [new MockMediaStreamTrack('audio', 'audio-track-1')] : [];
    this.videoTracks = video ? [new MockMediaStreamTrack('video', 'video-track-1')] : [];
  }

  getTracks() {
    return [...this.audioTracks, ...this.videoTracks];
  }

  getAudioTracks() {
    return [...this.audioTracks];
  }

  getVideoTracks() {
    return [...this.videoTracks];
  }
}

class MockBlob {
  size: number;
  type: string;

  constructor(
    public parts: string[] = [],
    options: {type?: string} = {}
  ) {
    this.type = options.type ?? 'audio/webm';
    this.size = parts.join('').length;
  }

  async arrayBuffer() {
    return new TextEncoder().encode(this.parts.join('')).buffer;
  }
}

class MockMediaRecorder {
  static isTypeSupported() {
    return true;
  }

  mimeType: string;
  ondataavailable: ((event: {data: MockBlob}) => void) | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private stream: MockMediaStream,
    options: {mimeType?: string} = {}
  ) {
    this.mimeType = options.mimeType ?? 'audio/webm';
  }

  start(intervalMs = 400) {
    this.state = 'recording';
    this.intervalHandle = setInterval(() => {
      if (this.stream.getAudioTracks().length === 0 || !this.ondataavailable) {
        return;
      }
      this.ondataavailable({data: new MockBlob(['mock-audio'], {type: this.mimeType})});
    }, intervalMs);
  }

  stop() {
    this.state = 'inactive';
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}

type MockSocketMessage = {
  data: string;
};

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MockSocketMessage) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = MockWebSocket.OPEN;
  private sessionId = 'mock-session';
  private sequenceId = 0;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.onopen?.(new Event('open'));
    }, 0);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new Event('close'));
  }

  send(payload: string) {
    const message = JSON.parse(payload) as Record<string, unknown>;
    const type = String(message.type ?? '');

    if (type === 'start_session') {
      this.onmessage?.({
        data: JSON.stringify({
          type: 'session_started',
          session_id: this.sessionId,
          mode: 'browser_fallback',
          requires_client_transcripts: true,
        }),
      });
      return;
    }

    if (type === 'audio_chunk') {
      this.onmessage?.({
        data: JSON.stringify({
          type: 'vad_state',
          state: 'listening',
        }),
      });
      return;
    }

    if (type === 'vad_state') {
      this.onmessage?.({
        data: JSON.stringify({
          type: 'vad_state',
          state: message.state ?? 'listening',
        }),
      });
      return;
    }

    if (type === 'client_transcript') {
      this.sequenceId += 1;
      const transcriptState = String(message.transcript_state ?? 'interim');
      this.onmessage?.({
        data: JSON.stringify({
          type: transcriptState === 'final' ? 'transcript_final' : 'transcript_interim',
          session_id: this.sessionId,
          sequence_id: this.sequenceId,
          text: message.text ?? '',
          confidence: message.confidence ?? null,
          created_at_ms: message.created_at_ms ?? Date.now(),
          speech_start_ms: message.speech_start_ms ?? null,
          speech_end_ms: message.speech_end_ms ?? null,
        }),
      });

      if (transcriptState === 'final') {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'vad_state',
            state: 'processing',
          }),
        });
      }
      return;
    }

    if (type === 'end_session') {
      this.onmessage?.({
        data: JSON.stringify({
          type: 'session_ended',
          session_id: this.sessionId,
        }),
      });
      this.close();
    }
  }
}

class MockSpeechRecognition extends EventTarget {
  static instances: MockSpeechRecognition[] = [];

  continuous = false;
  interimResults = false;
  lang = 'en-US';
  onend: ((event: Event) => void) | null = null;
  onerror: ((event: Event & {error?: string}) => void) | null = null;
  onresult: ((event: any) => void) | null = null;
  onspeechend: ((event: Event) => void) | null = null;
  onspeechstart: ((event: Event) => void) | null = null;

  constructor() {
    super();
    MockSpeechRecognition.instances.push(this);
  }

  start() {}

  stop() {
    this.onend?.(new Event('end'));
  }

  emitSpeechStart() {
    this.onspeechstart?.(new Event('speechstart'));
  }

  emitSpeechEnd() {
    this.onspeechend?.(new Event('speechend'));
  }

  emitInterimResult(transcript: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [
        {
          isFinal: false,
          0: {transcript},
          length: 1,
        },
      ],
    });
  }

  emitFinalResult(transcript: string, confidence = 0.88) {
    this.onresult?.({
      resultIndex: 0,
      results: [
        {
          isFinal: true,
          0: {transcript, confidence},
          length: 1,
        },
      ],
    });
  }
}

vi.stubGlobal('MediaStream', MockMediaStream);
vi.stubGlobal('MediaRecorder', MockMediaRecorder);
vi.stubGlobal('WebSocket', MockWebSocket);

Object.defineProperty(window, 'MediaStream', {
  configurable: true,
  writable: true,
  value: MockMediaStream,
});

Object.defineProperty(window, 'MediaRecorder', {
  configurable: true,
  writable: true,
  value: MockMediaRecorder,
});

Object.defineProperty(window, 'WebSocket', {
  configurable: true,
  writable: true,
  value: MockWebSocket,
});

Object.defineProperty(window, 'SpeechRecognition', {
  configurable: true,
  writable: true,
  value: MockSpeechRecognition,
});

Object.defineProperty(window, 'webkitSpeechRecognition', {
  configurable: true,
  writable: true,
  value: MockSpeechRecognition,
});

Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: {
    enumerateDevices: vi.fn(async () => [
      {deviceId: 'camera-1', kind: 'videoinput', label: 'Front Camera'},
      {deviceId: 'mic-1', kind: 'audioinput', label: 'Desk Mic'},
    ]),
    getUserMedia: vi.fn(async (constraints?: {audio?: boolean; video?: boolean}) => {
      const wantsVideo = constraints?.video !== false;
      const wantsAudio = constraints?.audio !== false;
      return new MockMediaStream({audio: wantsAudio, video: wantsVideo});
    }),
  },
});

Object.defineProperty(navigator, 'permissions', {
  configurable: true,
  value: {
    query: vi.fn(async () => ({state: 'prompt'})),
  },
});

class MockPoseViewerElement extends HTMLElement {
  currentTime = 0;

  duration = 1.5;

  readyState = 4;

  autoplay = false;

  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private renderToken = 0;

  get src() {
    return this.getAttribute('src') ?? '';
  }

  set src(value: string) {
    if (!value) {
      this.removeAttribute('src');
      return;
    }

    this.setAttribute('src', value);
  }

  setAttribute(name: string, value: string) {
    const previousValue = this.getAttribute(name);
    super.setAttribute(name, value);

    if (name === 'src' && value && value !== previousValue) {
      this.scheduleRenderLifecycle();
    }
  }

  constructor() {
    super();
    const root = this.attachShadow({mode: 'open'});
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 320;
    root.appendChild(canvas);
  }

  disconnectedCallback() {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
  }

  connectedCallback() {
    if (this.getAttribute('src')) {
      this.scheduleRenderLifecycle();
    }
  }

  play = vi.fn(async () => {
    this.dispatchEvent(new CustomEvent('play$'));

    if (this.dataset.role === 'visible') {
      this.finishTimer = setTimeout(() => {
        this.dispatchEvent(new CustomEvent('ended$'));
        this.finishTimer = null;
      }, 30);
    }
  });

  pause = vi.fn(async () => {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }

    this.dispatchEvent(new CustomEvent('pause$'));
  });

  private scheduleRenderLifecycle() {
    const token = ++this.renderToken;
    const renderDelay = this.dataset.role === 'probe' ? 5 : 20;

    setTimeout(() => {
      if (token !== this.renderToken) {
        return;
      }

      this.dispatchEvent(new CustomEvent('loadedmetadata$'));
      this.dispatchEvent(new CustomEvent('canplaythrough$'));
      this.dispatchEvent(new CustomEvent('firstRender$'));
    }, renderDelay);
  }
}

if (!customElements.get('pose-viewer')) {
  customElements.define('pose-viewer', MockPoseViewerElement);
}

vi.mock('../lib/poseViewer', () => ({
  ensurePoseViewerDefined: vi.fn().mockResolvedValue(undefined),
}));
