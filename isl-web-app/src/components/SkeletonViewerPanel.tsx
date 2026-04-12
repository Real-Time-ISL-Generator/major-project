import {useEffect, useRef, useState} from 'react';
import type {PlaybackChunk, PlaybackState} from '../lib/playback';
import {ensurePoseViewerDefined} from '../lib/poseViewer';

type PoseViewerHandle = HTMLElement & {
  duration: number;
};

type SkeletonViewerPanelProps = {
  activeIndex: number;
  chunks: PlaybackChunk[];
  error: string | null;
  playbackState: PlaybackState;
  visibleChunkIndex: number | null;
  visiblePoseSrc: string | null;
  onVisibleViewerEnded: () => void;
  onVisibleViewerError: (message: string) => void;
  onVisibleViewerReady: (duration: number) => void;
  onVisibleViewerRef: (node: HTMLElement | null) => void;
};

function getViewerStatusLabel(playbackState: PlaybackState): string {
  switch (playbackState) {
    case 'loadingSource':
      return 'Loading source';
    case 'chunking':
      return 'Building semantic chunks';
    case 'preparingInitialChunks':
      return 'Preparing first chunks';
    case 'bindingVisibleChunk':
      return 'Loading next chunk';
    case 'ready':
      return 'Ready';
    case 'playing':
      return 'Playing';
    case 'completed':
      return 'Completed';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}

function getOverlayCopy(playbackState: PlaybackState): string | null {
  switch (playbackState) {
    case 'preparingInitialChunks':
      return 'Preparing initial chunks…';
    case 'bindingVisibleChunk':
      return 'Loading next chunk…';
    case 'playing':
      return 'Playing current chunk…';
    default:
      return null;
  }
}

function getChunkStatusLabel(
  chunk: PlaybackChunk,
  index: number,
  activeIndex: number
): string {
  if (index === activeIndex && chunk.visibleStatus === 'ready') {
    return 'Playing';
  }

  if (index === activeIndex && chunk.visibleStatus === 'binding') {
    return 'Loading';
  }

  return 'Idle';
}

export function SkeletonViewerPanel({
  activeIndex,
  chunks,
  error,
  playbackState,
  visibleChunkIndex,
  visiblePoseSrc,
  onVisibleViewerEnded,
  onVisibleViewerError,
  onVisibleViewerReady,
  onVisibleViewerRef,
}: SkeletonViewerPanelProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const detachVisibleListenersRef = useRef<(() => void) | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [backgroundColor, setBackgroundColor] = useState('');

  useEffect(() => {
    ensurePoseViewerDefined()
      .then(() => setViewerReady(true))
      .catch(() => {
        setViewerError('The skeleton viewer could not be loaded.');
      });
  }, []);

  useEffect(() => {
    if (!frameRef.current) {
      return;
    }

    setBackgroundColor(getComputedStyle(frameRef.current).backgroundColor);
  }, [visiblePoseSrc]);

  useEffect(() => {
    return () => {
      detachVisibleListenersRef.current?.();
    };
  }, []);

  function bindVisibleViewerRef(node: HTMLElement | null) {
    detachVisibleListenersRef.current?.();
    detachVisibleListenersRef.current = null;

    onVisibleViewerRef(node);

    if (!node) {
      return;
    }

    const visibleNode = node as PoseViewerHandle;
    const handleFirstRender = () => {
      setViewerError(null);
      const duration = Number.isFinite(visibleNode.duration) ? Number(visibleNode.duration) : NaN;
      onVisibleViewerReady(duration);
    };
    const handleEnded = () => {
      onVisibleViewerEnded();
    };
    const handleError = () => {
      onVisibleViewerError('The skeleton output could not be rendered.');
    };

    visibleNode.addEventListener('firstRender$', handleFirstRender as EventListener);
    visibleNode.addEventListener('ended$', handleEnded as EventListener);
    visibleNode.addEventListener('error', handleError as EventListener);

    detachVisibleListenersRef.current = () => {
      visibleNode.removeEventListener('firstRender$', handleFirstRender as EventListener);
      visibleNode.removeEventListener('ended$', handleEnded as EventListener);
      visibleNode.removeEventListener('error', handleError as EventListener);
    };
  }

  const visibleError = error ?? viewerError;
  const activeChunk = chunks[activeIndex] ?? null;
  const nextChunk = chunks[activeIndex + 1] ?? null;
  const overlayCopy = getOverlayCopy(playbackState);
  const showLoading = !viewerReady || overlayCopy !== null;

  return (
    <section className="panel panel-viewer" aria-label="Stick figure output panel">
      <div className="viewer-header">
        <div className="viewer-header-copy">
          <span className="viewer-status-pill">{getViewerStatusLabel(playbackState)}</span>
          <strong>{activeChunk ? 'Chunk playback' : 'Skeleton output'}</strong>
          <p>
            {activeChunk
              ? 'The active transcript, video span, and skeleton pose stay locked to the same chunk.'
              : 'Add text, upload subtitles, or submit a YouTube link to start the skeleton output.'}
          </p>
        </div>
        {nextChunk ? (
          <div className="viewer-next-chip" aria-live="polite">
            <span>Next</span>
            <strong>
              {playbackState === 'bindingVisibleChunk' ? 'Loading now' : 'Queued'}
            </strong>
          </div>
        ) : null}
      </div>

      <div className="viewer-body">
        <div className="viewer-frame" ref={frameRef}>
          {!visiblePoseSrc ? (
            <div className="viewer-empty">
              <p>Add text, upload subtitles, or submit a YouTube link to start the skeleton output.</p>
            </div>
          ) : (
            <>
              <pose-viewer
                key={`visible-${visibleChunkIndex ?? 'empty'}-${visiblePoseSrc}`}
                className="pose-viewer-slot pose-viewer-slot-active"
                data-role="visible"
                ref={bindVisibleViewerRef}
                autoplay={false}
                aspect-ratio="1"
                background={backgroundColor || undefined}
                renderer="canvas"
                src={visiblePoseSrc}
                width="100%"
              />
            </>
          )}

          {showLoading && overlayCopy ? (
            <div className="viewer-overlay" role="status" aria-live="polite">
              {overlayCopy}
            </div>
          ) : null}

          {visibleError ? (
            <div className="viewer-overlay viewer-overlay-error" role="alert">
              {visibleError}
            </div>
          ) : null}
        </div>

        <aside className="transcript-panel" aria-label="Transcript chunks">
          <div className="transcript-panel-header">
            <strong>Transcript</strong>
            <span>{chunks.length} chunks</span>
          </div>

          <div className="transcript-list">
            {chunks.length === 0 ? (
              <p className="transcript-empty">Your chunked transcript will appear here.</p>
            ) : (
              chunks.map((chunk, index) => {
                const isActive = index === activeIndex;
                const isUpcoming = index === activeIndex + 1;

                return (
                  <article
                    key={chunk.id}
                    className={[
                      'transcript-item',
                      isActive ? 'transcript-item-active' : '',
                      isUpcoming ? 'transcript-item-upcoming' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-current={isActive ? 'true' : undefined}
                  >
                    <div className="transcript-item-meta">
                      <span>Chunk {index + 1}</span>
                      <span>{getChunkStatusLabel(chunk, index, activeIndex)}</span>
                    </div>
                    <p>{chunk.text}</p>
                  </article>
                );
              })
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
