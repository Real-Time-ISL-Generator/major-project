/// <reference types="vite/client" />

import type {DetailedHTMLProps, HTMLAttributes} from 'react';

type PoseViewerEventHandler = (event: Event) => void;

interface PoseViewerElement extends HTMLElement {
  autoplay: boolean;
  background: string | null;
  currentTime: number;
  duration: number;
  playbackRate: number;
  readyState: number;
  src: string | null;
  pause: () => Promise<void>;
  play: () => Promise<void>;
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'pose-viewer': DetailedHTMLProps<HTMLAttributes<PoseViewerElement>, PoseViewerElement> & {
        autoplay?: boolean;
        background?: string;
        src?: string;
        width?: string;
        renderer?: 'canvas' | 'svg' | 'interactive';
        'aspect-ratio'?: string;
        onCanplaythrough$?: PoseViewerEventHandler;
        onEnded$?: PoseViewerEventHandler;
        onFirstRender$?: PoseViewerEventHandler;
        onLoadedmetadata$?: PoseViewerEventHandler;
        onPause$?: PoseViewerEventHandler;
        onPlay$?: PoseViewerEventHandler;
      };
    }
  }
}
