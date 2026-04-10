import {useEffect, useMemo, useRef, useState} from 'react';
import {ensurePoseViewerDefined} from '../lib/poseViewer';

type SkeletonViewerPanelProps = {
  src: string | null;
  loading: boolean;
  error: string | null;
  captionText: string | null;
};

export function SkeletonViewerPanel({src, loading, error, captionText}: SkeletonViewerPanelProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const poseViewerRef = useRef<HTMLElement | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [backgroundColor, setBackgroundColor] = useState('');

  useEffect(() => {
    ensurePoseViewerDefined().catch(() => {
      setViewerError('The skeleton viewer could not be loaded.');
    });
  }, []);

  useEffect(() => {
    if (!frameRef.current) {
      return;
    }

    setBackgroundColor(getComputedStyle(frameRef.current).backgroundColor);
  }, [src]);

  useEffect(() => {
    setViewerReady(false);
    setViewerError(null);
  }, [src]);

  useEffect(() => {
    const poseViewer = poseViewerRef.current;
    if (!poseViewer || !src) {
      return;
    }

    const handleFirstRender = () => {
      setViewerReady(true);
      setViewerError(null);
    };

    const handleError = () => {
      setViewerReady(false);
      setViewerError('The skeleton output could not be rendered.');
    };

    poseViewer.addEventListener('firstRender$', handleFirstRender as EventListener);
    poseViewer.addEventListener('error', handleError as EventListener);

    return () => {
      poseViewer.removeEventListener('firstRender$', handleFirstRender as EventListener);
      poseViewer.removeEventListener('error', handleError as EventListener);
    };
  }, [src]);

  const showLoading = useMemo(() => {
    if (!src) {
      return false;
    }

    return loading || !viewerReady;
  }, [loading, src, viewerReady]);

  const visibleError = error ?? viewerError;

  return (
    <section className="panel panel-viewer" aria-label="Stick figure output panel">
      {captionText ? (
        <div className="viewer-caption" aria-live="polite">
          <span className="viewer-caption-label">Now signing</span>
          <span className="viewer-caption-text">{captionText}</span>
        </div>
      ) : null}

      <div className="viewer-frame" ref={frameRef}>

        {!src ? (
          <div className="viewer-empty">
            <p>Add text, upload subtitles, or submit a YouTube link to start the skeleton output.</p>
          </div>
        ) : (
          <pose-viewer
            key={src}
            ref={node => {
              poseViewerRef.current = node;
            }}
            autoplay="true"
            aspect-ratio="1"
            background={backgroundColor || undefined}
            src={src}
            width="100%"
          />
        )}

        {showLoading ? (
          <div className="viewer-overlay" role="status" aria-live="polite">
            Rendering stick figure...
          </div>
        ) : null}

        {visibleError ? (
          <div className="viewer-overlay viewer-overlay-error" role="alert">
            {visibleError}
          </div>
        ) : null}
      </div>
    </section>
  );
}

