import {useEffect, useRef, useState} from 'react';
import type {PlaybackChunk, PlaybackState} from '../lib/playback';
import {ensurePoseViewerDefined} from '../lib/poseViewer';

type PoseViewerHandle = HTMLElement & {
  duration: number;
};

type SkeletonViewerPanelProps = {
  activeIndex: number;
  allowTranscriptToggle: boolean;
  chunks: PlaybackChunk[];
  error: string | null;
  liveInterimText?: string;
  liveMode?: boolean;
  liveQueuedCount?: number;
  liveSignedText?: string;
  liveStatusLabel?: string | null;
  nextQueuedText?: string | null;
  playbackState: PlaybackState;
  visibleChunkIndex: number | null;
  visiblePoseSrc: string | null;
  onVisibleViewerEnded: () => void;
  onVisibleViewerError: (message: string) => void;
  onVisibleViewerReady: (duration: number) => void;
  onVisibleViewerRef: (node: HTMLElement | null) => void;
};

type ViewerStatusOverlay = {
  label: string;
  tone: 'loading' | 'playing';
};

function getStatusOverlay(playbackState: PlaybackState): ViewerStatusOverlay | null {
  switch (playbackState) {
    case 'preparingInitialChunks':
      return {
        label: 'Preparing initial chunks',
        tone: 'loading',
      };
    case 'bindingVisibleChunk':
      return {
        label: 'Loading next chunk',
        tone: 'loading',
      };
    case 'playing':
      return {
        label: 'Playing current chunk',
        tone: 'playing',
      };
    default:
      return null;
  }
}

export function SkeletonViewerPanel({
  activeIndex,
  allowTranscriptToggle,
  chunks,
  error,
  liveInterimText = '',
  liveMode = false,
  liveQueuedCount = 0,
  liveSignedText = '',
  liveStatusLabel = null,
  nextQueuedText = null,
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
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false);
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

  useEffect(() => {
    if (!allowTranscriptToggle || chunks.length === 0) {
      setIsTranscriptOpen(false);
    }
  }, [allowTranscriptToggle, chunks.length]);

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
  const isCaptionMode = activeChunk?.sourceMode === 'groq';
  const statusOverlay = getStatusOverlay(playbackState);
  const showLoading = !viewerReady || statusOverlay !== null;
  const isVideoBacked = activeChunk?.sourceMode === 'youtube' || liveMode;
  const showChunkToggle = allowTranscriptToggle && chunks.length > 0;
  const showChunkBubble = Boolean(
    allowTranscriptToggle && isTranscriptOpen && activeChunk?.text.trim()
  );
  const showLiveBubble = liveMode && Boolean(liveSignedText || liveInterimText || nextQueuedText);

  return (
    <section className="panel panel-viewer" aria-label="Stick figure output panel">
      <div className="panel-section-header panel-section-header-viewer">
        <div className="panel-section-copy">
          <p className="panel-section-label">{liveMode ? 'Live signer' : 'Avatar Preview'}</p>
          {liveStatusLabel ? <h2>{liveStatusLabel}</h2> : null}
        </div>
        {liveMode ? (
          <div className="live-viewer-meta">
            <span className="viewer-live-chip">{`Queue ${liveQueuedCount}`}</span>
          </div>
        ) : null}
      </div>

      <div className="viewer-stage">
        <div
          className={isVideoBacked ? 'viewer-frame viewer-frame-video' : 'viewer-frame viewer-frame-standalone'}
          ref={frameRef}
        >
          {showChunkToggle ? (
            <button
              type="button"
              className={
                isTranscriptOpen
                  ? 'viewer-toggle viewer-toggle-active viewer-frame-action'
                  : 'viewer-toggle viewer-frame-action'
              }
              onClick={() => setIsTranscriptOpen(prev => !prev)}
            >
              {isTranscriptOpen
                ? isCaptionMode
                  ? 'Hide caption'
                  : 'Hide chunks'
                : isCaptionMode
                  ? 'Show caption'
                  : 'Show chunks'}
            </button>
          ) : null}

          {!visiblePoseSrc ? (
            <div className="viewer-empty">
              <p>Add text, upload subtitles, or submit a YouTube link to start the skeleton output.</p>
            </div>
          ) : (
            <div className={isVideoBacked ? 'viewer-stage-shell viewer-stage-shell-video' : 'viewer-stage-shell viewer-stage-shell-standalone'}>
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
            </div>
          )}

          {showLoading && statusOverlay ? (
            <div
              className={
                statusOverlay.tone === 'playing'
                  ? 'viewer-overlay viewer-overlay-icon viewer-overlay-playing'
                  : 'viewer-overlay viewer-overlay-icon viewer-overlay-loading'
              }
              role="status"
              aria-live="polite"
              aria-label={statusOverlay.label}
              title={statusOverlay.label}
            >
              <span className="sr-only">{statusOverlay.label}</span>
              {statusOverlay.tone === 'loading' ? (
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path d="M12 3a9 9 0 1 0 9 9" />
                  <path d="M16 3h5v5" />
                  <path d="M21 3l-6 6" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path className="viewer-eq-bar viewer-eq-bar-1" d="M7 17V9" />
                  <path className="viewer-eq-bar viewer-eq-bar-2" d="M12 19V6" />
                  <path className="viewer-eq-bar viewer-eq-bar-3" d="M17 15V8" />
                </svg>
              )}
            </div>
          ) : null}

          {showChunkBubble ? (
            <article
              className="viewer-chunk-bubble"
              aria-live="polite"
              aria-label={isCaptionMode ? 'LLM answer caption' : 'Current chunk text'}
            >
              <span className="viewer-chunk-eyebrow">
                {isCaptionMode ? 'Answer' : `Chunk ${activeIndex + 1}`}
              </span>
              <p>{activeChunk?.text}</p>
            </article>
          ) : null}

          {showLiveBubble ? (
            <article className="viewer-chunk-bubble viewer-live-bubble" aria-live="polite" aria-label="Live signer status">
              <span className="viewer-chunk-eyebrow">Live phrase</span>
              <p>{liveSignedText || liveInterimText || 'Listening for the next phrase.'}</p>
              {liveInterimText && !liveSignedText ? (
                <span className="viewer-live-note">Interim transcript</span>
              ) : null}
              {nextQueuedText ? (
                <span className="viewer-live-note">{`Next up: ${nextQueuedText}`}</span>
              ) : null}
            </article>
          ) : null}

          {visibleError ? (
            <div className="viewer-overlay viewer-overlay-error" role="alert">
              {visibleError}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
