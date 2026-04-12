import '@testing-library/jest-dom/vitest';
import {vi} from 'vitest';

HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,mock');

vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 16)
);
vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
  window.clearTimeout(handle);
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
