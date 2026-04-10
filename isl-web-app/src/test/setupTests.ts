import '@testing-library/jest-dom/vitest';
import {vi} from 'vitest';

if (!customElements.get('pose-viewer')) {
  customElements.define('pose-viewer', class extends HTMLElement {});
}

vi.mock('../lib/poseViewer', () => ({
  ensurePoseViewerDefined: vi.fn().mockResolvedValue(undefined),
}));

