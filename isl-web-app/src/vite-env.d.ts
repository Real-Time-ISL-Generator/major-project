/// <reference types="vite/client" />

import type {DetailedHTMLProps, HTMLAttributes} from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'pose-viewer': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        autoplay?: string;
        background?: string;
        width?: string;
        'aspect-ratio'?: string;
      };
    }
  }
}
