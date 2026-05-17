import {useEffect, useMemo, useRef, useState} from 'react';
import {SkeletonViewerPanel} from './components/SkeletonViewerPanel';
import {TextInputPanel, type InputMode} from './components/TextInputPanel';
import {
  VideoModePanel,
  type LiveTranscriptEvent,
  type VideoModeSessionPhase,
} from './components/VideoModePanel';
import {buildBackendUrl} from './lib/backend';
import {
  createGroqPlaybackChunks,
  createLivePlaybackChunk,
  createPlaybackChunks,
  createTextPlaybackChunks,
  type PlaybackChunk,
  type PlaybackState,
} from './lib/playback';
import {mergeSubtitleCues, parseSubtitleCues} from './lib/subtitleParser';

type SubmissionPayload = {
  text: string;
  videoUrl: string;
  fileContent: string;
  llmPrompt: string;
};

type SegmentProgress = {
  videoDone: boolean;
  poseDone: boolean;
};

type PoseViewerHandle = HTMLElement & {
  currentTime: number;
  duration: number;
  pause: () => Promise<void>;
  play: () => Promise<void>;
};

type YouTubePlayerHandle = {
  destroy?: () => void;
  getCurrentTime?: () => number;
  pauseVideo?: () => void;
  playVideo?: () => void;
  seekTo?: (seconds: number, allowSeekAhead?: boolean) => void;
};

const LIVE_QUEUE_LIMIT = 3;
const VIDEO_END_TOLERANCE = 0.05;

async function getResponseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    if (typeof data?.detail === 'string' && data.detail.trim()) {
      return data.detail;
    }
    if (typeof data?.error === 'string' && data.error.trim()) {
      return data.error;
    }
  } catch {
    // Ignore JSON parse failures and use fallback below.
  }

  return fallback;
}

function App() {
  const [activeMode, setActiveMode] = useState<InputMode>('youtube');
  const [chunks, setChunks] = useState<PlaybackChunk[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [visibleChunkIndex, setVisibleChunkIndex] = useState<number | null>(null);
  const [visiblePoseSrc, setVisiblePoseSrc] = useState<string | null>(null);
  const [segmentProgress, setSegmentProgress] = useState<SegmentProgress>({
    videoDone: false,
    poseDone: false,
  });
  const [videoId, setVideoId] = useState<string | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState>('idle');
  const [appError, setAppError] = useState<string | null>(null);
  const [ytReady, setYtReady] = useState(false);
  const [runId, setRunId] = useState(0);
  const [videoSessionActive, setVideoSessionActive] = useState(false);
  const [videoSessionPhase, setVideoSessionPhase] = useState<VideoModeSessionPhase>('idle');
  const [latestLivePhrase, setLatestLivePhrase] = useState('');

  const playerRef = useRef<YouTubePlayerHandle | null>(null);
  const visibleViewerRef = useRef<PoseViewerHandle | null>(null);
  const videoMonitorRef = useRef<number | null>(null);
  const videoPauseTimeoutRef = useRef<number | null>(null);
  const videoSegmentTokenRef = useRef(0);
  const virtualMonitorRef = useRef<number | null>(null);
  const submissionRef = useRef(0);
  const startedChunkKeyRef = useRef<string | null>(null);

  const chunksRef = useRef(chunks);
  const activeIndexRef = useRef(activeIndex);
  const visibleChunkIndexRef = useRef(visibleChunkIndex);

  useEffect(() => {
    chunksRef.current = chunks;
  }, [chunks]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  useEffect(() => {
    visibleChunkIndexRef.current = visibleChunkIndex;
  }, [visibleChunkIndex]);

  useEffect(() => {
    if ((window as typeof window & {YT?: unknown}).YT) {
      setYtReady(true);
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';

    (window as typeof window & {onYouTubeIframeAPIReady?: () => void}).onYouTubeIframeAPIReady = () => {
      setYtReady(true);
    };

    document.body.appendChild(tag);
  }, []);

  useEffect(() => {
    if (!videoId || !ytReady) {
      if (!videoId && playerRef.current && typeof playerRef.current.destroy === 'function') {
        playerRef.current.destroy();
        playerRef.current = null;
      }
      setPlayerReady(false);
      return;
    }

    setPlayerReady(false);

    if (playerRef.current && typeof playerRef.current.destroy === 'function') {
      playerRef.current.destroy();
    }

    playerRef.current = new (window as typeof window & {YT: any}).YT.Player('player', {
      videoId,
      events: {
        onReady: () => setPlayerReady(true),
        onError: () => {
          setPlayerReady(false);
          setPlaybackState('error');
          setAppError('Could not load the YouTube player for this link.');
        },
      },
    });
  }, [videoId, ytReady]);

  const liveQueueSummary = useMemo(() => {
    const liveChunks = chunks.filter(chunk => chunk.sourceMode === 'video');
    const queuedChunks = liveChunks.filter(chunk =>
      chunk.queueStatus === 'pending' || chunk.queueStatus === 'ready' || chunk.queueStatus === 'playing'
    );
    const activeLiveChunk =
      activeMode === 'video' &&
      chunks[activeIndex]?.sourceMode === 'video' &&
      chunks[activeIndex]?.queueStatus !== 'played' &&
      chunks[activeIndex]?.queueStatus !== 'error'
        ? chunks[activeIndex]
        : null;
    const nextQueuedChunk = activeLiveChunk
      ? chunks.find(
          (chunk, index) =>
            index > activeIndex &&
            chunk.sourceMode === 'video' &&
            (chunk.queueStatus === 'pending' || chunk.queueStatus === 'ready')
        ) ?? null
      : queuedChunks.find(chunk => chunk.queueStatus === 'pending' || chunk.queueStatus === 'ready') ?? null;

    return {
      currentText: activeLiveChunk?.text?.trim() || latestLivePhrase.trim(),
      isLagging: queuedChunks.length > LIVE_QUEUE_LIMIT - 1,
      nextQueuedText: nextQueuedChunk?.text ?? null,
      queuedCount: queuedChunks.length,
    };
  }, [activeIndex, activeMode, chunks, latestLivePhrase]);

  const viewerStatusLabel = useMemo(() => {
    if (activeMode !== 'video') {
      return null;
    }
    if (playbackState === 'playing') {
      return liveQueueSummary.isLagging ? 'Signing and catching up' : 'Signing now';
    }
    switch (videoSessionPhase) {
      case 'connecting':
        return 'Connecting live speech';
      case 'testing':
        return 'Testing devices';
      case 'processing':
        return 'Processing phrase';
      case 'listening':
        return 'Listening for speech';
      case 'unsupported':
        return 'Browser support needed';
      case 'error':
        return 'Session needs attention';
      default:
        return 'Live signer ready';
    }
  }, [activeMode, liveQueueSummary.isLagging, playbackState, videoSessionPhase]);

  function cancelVideoMonitor() {
    if (videoMonitorRef.current !== null) {
      cancelAnimationFrame(videoMonitorRef.current);
      videoMonitorRef.current = null;
    }
  }

  function cancelVideoPauseTimeout() {
    if (videoPauseTimeoutRef.current !== null) {
      window.clearTimeout(videoPauseTimeoutRef.current);
      videoPauseTimeoutRef.current = null;
    }
  }

  function cancelVirtualMonitor() {
    if (virtualMonitorRef.current !== null) {
      cancelAnimationFrame(virtualMonitorRef.current);
      virtualMonitorRef.current = null;
    }
  }

  function invalidateVideoSegment() {
    videoSegmentTokenRef.current += 1;
    cancelVideoMonitor();
    cancelVideoPauseTimeout();
  }

  async function stopRuntime() {
    invalidateVideoSegment();
    cancelVirtualMonitor();

    if (playerRef.current && typeof playerRef.current.pauseVideo === 'function') {
      playerRef.current.pauseVideo();
    }

    await Promise.all(
      [visibleViewerRef.current].map(async viewer => {
        if (!viewer) {
          return;
        }

        try {
          await viewer.pause();
        } catch {
          // Ignore pause failures while tearing down.
        }
      })
    );
  }

  function updateChunks(updater: (prevChunks: PlaybackChunk[]) => PlaybackChunk[]) {
    setChunks(prevChunks => {
      const nextChunks = updater(prevChunks);
      chunksRef.current = nextChunks;
      return nextChunks;
    });
  }

  function updateChunk(index: number, updater: (chunk: PlaybackChunk) => PlaybackChunk) {
    updateChunks(prevChunks =>
      prevChunks.map((chunk, chunkIndex) => (chunkIndex === index ? updater(chunk) : chunk))
    );
  }

  function markChunkVisibleBinding(index: number) {
    updateChunks(prevChunks =>
      prevChunks.map((chunk, chunkIndex) => ({
        ...chunk,
        visibleStatus: chunkIndex === index ? 'binding' : 'idle',
      }))
    );
  }

  function markChunkVisibleReady(index: number, duration: number) {
    updateChunks(prevChunks =>
      prevChunks.map((chunk, chunkIndex) => ({
        ...chunk,
        poseDuration:
          chunkIndex === index && Number.isFinite(duration) && duration > 0 ? duration : chunk.poseDuration,
        queueStatus: chunkIndex === index && chunk.queueStatus === 'pending' ? 'ready' : chunk.queueStatus,
        visibleStatus: chunkIndex === index ? 'ready' : 'idle',
      }))
    );
  }

  function markChunkError(index: number, message: string) {
    updateChunk(index, chunk => ({
      ...chunk,
      error: message,
      queueStatus: 'error',
    }));
  }

  function bindVisibleChunk(index: number) {
    const chunk = chunksRef.current[index];
    if (!chunk) {
      return;
    }

    setVisibleChunkIndex(index);
    visibleChunkIndexRef.current = index;
    setVisiblePoseSrc(chunk.poseUrl);
    markChunkVisibleBinding(index);
  }

  function resetLiveModeState() {
    setVideoSessionActive(false);
    setVideoSessionPhase('idle');
    setLatestLivePhrase('');
  }

  function resetSession(nextState: PlaybackState = 'idle') {
    submissionRef.current += 1;
    setRunId(submissionRef.current);
    startedChunkKeyRef.current = null;
    void stopRuntime();
    setChunks([]);
    chunksRef.current = [];
    setActiveIndex(0);
    activeIndexRef.current = 0;
    setVisibleChunkIndex(null);
    visibleChunkIndexRef.current = null;
    setVisiblePoseSrc(null);
    setSegmentProgress({
      videoDone: false,
      poseDone: false,
    });
    setVideoId(null);
    setPlayerReady(false);
    setAppError(null);
    setPlaybackState(nextState);
  }

  function initializePlayback(nextChunks: PlaybackChunk[], nextVideoId: string | null) {
    setChunks(nextChunks);
    chunksRef.current = nextChunks;
    setVideoId(nextVideoId);
    setSegmentProgress({
      videoDone: false,
      poseDone: false,
    });
    setAppError(null);
    transitionToChunk(0);
  }

  async function handleSubmit({text, videoUrl, fileContent, llmPrompt}: SubmissionPayload) {
    resetSession('loadingSource');

    const sessionId = submissionRef.current;

    try {
      if (videoUrl) {
        const res = await fetch(
          `${buildBackendUrl('/download')}?url=${encodeURIComponent(videoUrl)}`
        );

        if (sessionId !== submissionRef.current) {
          return;
        }

        if (!res.ok) {
          throw new Error(
            await getResponseErrorMessage(
              res,
              'Backend request failed while downloading subtitles.'
            )
          );
        }

        const data = await res.json();
        const subtitleRef = data.subtitle_url ?? data.subtitle;

        if (!data.video_id || !subtitleRef) {
          throw new Error('No subtitles found for this YouTube link.');
        }

        const subtitlePath = subtitleRef.startsWith('/') ? subtitleRef : `/${subtitleRef}`;
        const subtitleRes = await fetch(buildBackendUrl(subtitlePath));

        if (sessionId !== submissionRef.current) {
          return;
        }

        if (!subtitleRes.ok) {
          throw new Error(
            await getResponseErrorMessage(
              subtitleRes,
              'Could not fetch subtitle file from backend.'
            )
          );
        }

        const subtitleText = await subtitleRes.text();
        setPlaybackState('chunking');
        const cues = parseSubtitleCues(subtitleText);
        const mergedChunks = mergeSubtitleCues(cues);
        const playbackChunks = createPlaybackChunks(mergedChunks, 'youtube');

        if (playbackChunks.length === 0) {
          throw new Error('Subtitle file was empty or could not be parsed.');
        }

        initializePlayback(playbackChunks, data.video_id);
        return;
      }

      if (fileContent) {
        setPlaybackState('chunking');
        const cues = parseSubtitleCues(fileContent);
        const mergedChunks = mergeSubtitleCues(cues);
        const playbackChunks = createPlaybackChunks(mergedChunks, 'file');

        if (playbackChunks.length === 0) {
          throw new Error('Subtitle file was empty or could not be parsed.');
        }

        initializePlayback(playbackChunks, null);
        return;
      }

      if (text) {
        const playbackChunks = createTextPlaybackChunks(text);

        if (playbackChunks.length === 0) {
          throw new Error('Add some text, subtitle content, or a YouTube link first.');
        }

        initializePlayback(playbackChunks, null);
        return;
      }

      if (llmPrompt) {
        const res = await fetch(buildBackendUrl('/groq/concise-answer'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({prompt: llmPrompt}),
        });

        if (sessionId !== submissionRef.current) {
          return;
        }

        if (!res.ok) {
          throw new Error(
            await getResponseErrorMessage(
              res,
              'Backend request failed while asking Groq.'
            )
          );
        }

        const data = await res.json();
        const answer = typeof data?.answer === 'string' ? data.answer.trim() : '';
        const playbackChunks = createGroqPlaybackChunks(answer);

        if (playbackChunks.length === 0) {
          throw new Error('Groq returned an empty answer.');
        }

        initializePlayback(playbackChunks, null);
        return;
      }

      throw new Error('Add some text, subtitle content, a Groq prompt, or a YouTube link first.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not process the input.';
      setPlaybackState('error');
      setAppError(message);
      setChunks([]);
      chunksRef.current = [];
      setVisibleChunkIndex(null);
      setVisiblePoseSrc(null);
    }
  }

  function handleClear() {
    resetSession('idle');
  }

  function handleModeChange(nextMode: InputMode) {
    if (nextMode === activeMode) {
      return;
    }

    setActiveMode(nextMode);
    resetSession('idle');
    resetLiveModeState();
  }

  function handleVisibleViewerRef(node: HTMLElement | null) {
    visibleViewerRef.current = node as PoseViewerHandle | null;
  }

  function handleVisibleViewerReady(duration: number) {
    const index = visibleChunkIndexRef.current;
    if (index === null) {
      return;
    }

    markChunkVisibleReady(index, duration);
  }

  function handleVisibleViewerEnded() {
    setSegmentProgress(prevProgress =>
      prevProgress.poseDone ? prevProgress : {...prevProgress, poseDone: true}
    );
  }

  function handleVisibleViewerError(message: string) {
    const index = visibleChunkIndexRef.current;
    const chunk = index !== null ? chunksRef.current[index] : null;

    if (index !== null) {
      markChunkError(index, message);
    }

    if (chunk?.sourceMode === 'video') {
      setSegmentProgress({
        videoDone: true,
        poseDone: true,
      });
      return;
    }

    setAppError(message);
    setPlaybackState('error');
  }

  function finishVirtualSegment(duration: number) {
    const startTime = performance.now();

    const step = () => {
      if (performance.now() - startTime >= duration * 1000) {
        setSegmentProgress(prevProgress =>
          prevProgress.videoDone ? prevProgress : {...prevProgress, videoDone: true}
        );
        virtualMonitorRef.current = null;
        return;
      }

      virtualMonitorRef.current = requestAnimationFrame(step);
    };

    virtualMonitorRef.current = requestAnimationFrame(step);
  }

  function finishVideoSegment(segmentToken: number, endTime: number) {
    if (segmentToken !== videoSegmentTokenRef.current) {
      return;
    }

    videoSegmentTokenRef.current += 1;
    cancelVideoMonitor();
    cancelVideoPauseTimeout();

    const player = playerRef.current;
    if (player) {
      const currentTime = Number(player.getCurrentTime?.() ?? 0);
      if (Number.isFinite(currentTime) && currentTime > endTime + VIDEO_END_TOLERANCE) {
        player.seekTo?.(endTime, true);
      }
      player.pauseVideo?.();
    }

    setSegmentProgress(prevProgress =>
      prevProgress.videoDone ? prevProgress : {...prevProgress, videoDone: true}
    );
  }

  function monitorVideoSegment(startTime: number, endTime: number) {
    invalidateVideoSegment();
    const segmentToken = videoSegmentTokenRef.current;
    const safeDuration = Math.max(0, endTime - startTime) * 1000;

    videoPauseTimeoutRef.current = window.setTimeout(() => {
      finishVideoSegment(segmentToken, endTime);
    }, safeDuration);

    const step = () => {
      if (segmentToken !== videoSegmentTokenRef.current) {
        return;
      }

      const player = playerRef.current;
      const currentTime = Number(player?.getCurrentTime?.() ?? 0);

      if (!player || currentTime >= endTime - VIDEO_END_TOLERANCE) {
        finishVideoSegment(segmentToken, endTime);
        return;
      }

      videoMonitorRef.current = requestAnimationFrame(step);
    };

    videoMonitorRef.current = requestAnimationFrame(step);
  }

  async function startActiveChunk() {
    const currentChunk = chunksRef.current[activeIndexRef.current];
    const visibleViewer = visibleViewerRef.current;

    if (!currentChunk || !visibleViewer) {
      return;
    }

    await stopRuntime();
    updateChunk(activeIndexRef.current, chunk => ({
      ...chunk,
      queueStatus: 'playing',
    }));
    setPlaybackState('playing');
    setSegmentProgress({
      videoDone: false,
      poseDone: false,
    });

    visibleViewer.currentTime = 0;
    await visibleViewer.play();

    if (videoId) {
      const player = playerRef.current;

      if (!playerReady || !player?.seekTo || !player.playVideo) {
        setPlaybackState('error');
        setAppError('The YouTube player is not ready yet.');
        return;
      }

      player.seekTo(currentChunk.start, true);
      player.playVideo();
      monitorVideoSegment(currentChunk.start, currentChunk.end);
      return;
    }

    finishVirtualSegment(currentChunk.videoDuration);
  }

  function transitionToChunk(nextIndex: number) {
    setSegmentProgress({
      videoDone: false,
      poseDone: false,
    });
    setActiveIndex(nextIndex);
    activeIndexRef.current = nextIndex;
    setPlaybackState(nextIndex === 0 ? 'preparingInitialChunks' : 'bindingVisibleChunk');
    bindVisibleChunk(nextIndex);
  }

  useEffect(() => {
    if (playbackState !== 'preparingInitialChunks' && playbackState !== 'bindingVisibleChunk') {
      return;
    }

    const activeChunk = chunks[activeIndex];
    if (!activeChunk || activeChunk.visibleStatus !== 'ready') {
      return;
    }

    if (videoId && !playerReady) {
      return;
    }

    setPlaybackState('ready');
  }, [activeIndex, chunks, playbackState, playerReady, videoId]);

  useEffect(() => {
    if (playbackState !== 'ready') {
      return;
    }

    const chunk = chunks[activeIndex];
    if (!chunk || chunk.visibleStatus !== 'ready' || visibleChunkIndex !== activeIndex) {
      return;
    }

    const chunkKey = `${runId}-${activeIndex}`;
    if (startedChunkKeyRef.current === chunkKey) {
      return;
    }

    startedChunkKeyRef.current = chunkKey;
    void startActiveChunk();
  }, [activeIndex, chunks, playbackState, playerReady, runId, videoId, visibleChunkIndex]);

  useEffect(() => {
    if (!segmentProgress.videoDone || !segmentProgress.poseDone) {
      return;
    }

    updateChunk(activeIndex, chunk => ({
      ...chunk,
      queueStatus: chunk.queueStatus === 'error' ? 'error' : 'played',
    }));

    const nextIndex = chunks.findIndex(
      (chunk, index) =>
        index > activeIndex && chunk.queueStatus !== 'played' && chunk.queueStatus !== 'error'
    );

    if (nextIndex === -1) {
      setPlaybackState(videoSessionActive && activeMode === 'video' ? 'idle' : 'completed');
      return;
    }

    transitionToChunk(nextIndex);
  }, [activeIndex, activeMode, chunks, segmentProgress, videoSessionActive]);

  useEffect(() => {
    if (activeMode !== 'video' || !videoSessionActive) {
      return;
    }

    if (
      playbackState === 'playing' ||
      playbackState === 'ready' ||
      playbackState === 'bindingVisibleChunk' ||
      playbackState === 'preparingInitialChunks'
    ) {
      return;
    }

    const nextIndex = chunks.findIndex(
      chunk => chunk.sourceMode === 'video' && chunk.queueStatus !== 'played' && chunk.queueStatus !== 'error'
    );

    if (nextIndex !== -1) {
      transitionToChunk(nextIndex);
    }
  }, [activeMode, chunks, playbackState, videoSessionActive]);

  useEffect(() => {
    return () => {
      void stopRuntime();

      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        playerRef.current.destroy();
      }
    };
  }, []);

  function handleLiveTranscriptEvent(event: LiveTranscriptEvent) {
    if (event.transcriptState !== 'final' || !event.text.trim()) {
      return;
    }

    setLatestLivePhrase(event.text.trim());
    setAppError(null);

    updateChunks(prevChunks => {
      if (prevChunks.some(chunk => chunk.id === event.id)) {
        return prevChunks;
      }

      const nextChunks = [...prevChunks];
      const queuedLiveIndexes = nextChunks
        .map((chunk, index) =>
          chunk.sourceMode === 'video' &&
          chunk.queueStatus !== 'played' &&
          chunk.queueStatus !== 'error' &&
          chunk.queueStatus !== 'playing'
            ? index
            : -1
        )
        .filter(index => index >= 0);

      if (queuedLiveIndexes.length >= LIVE_QUEUE_LIMIT) {
        const mergeIndex = queuedLiveIndexes[queuedLiveIndexes.length - 1];
        const mergeTarget = nextChunks[mergeIndex];

        nextChunks[mergeIndex] = createLivePlaybackChunk({
          id: mergeTarget.id,
          text: `${mergeTarget.text} ${event.text}`,
          createdAtMs: event.createdAtMs,
          speechStartMs: mergeTarget.speechStartMs,
          speechEndMs: event.speechEndMs,
        });

        return nextChunks;
      }

      nextChunks.push(
        createLivePlaybackChunk({
          id: event.id,
          text: event.text,
          createdAtMs: event.createdAtMs,
          speechStartMs: event.speechStartMs,
          speechEndMs: event.speechEndMs,
        })
      );

      return nextChunks;
    });
  }

  return (
    <div className="app-shell">
      <section className="composer-shell">
        <div className="topbar-controls">
          <TextInputPanel
            activeMode={activeMode}
            onClear={handleClear}
            onModeChange={handleModeChange}
            onSubmit={handleSubmit}
          />
        </div>
      </section>

      <main
        className={
          activeMode === 'video'
            ? 'translation-grid translation-grid-live'
            : videoId
              ? 'translation-grid'
              : 'translation-grid translation-grid-no-video'
        }
      >
        {activeMode === 'video' ? (
          <VideoModePanel
            isLagging={liveQueueSummary.isLagging}
            latestSignedText={liveQueueSummary.currentText}
            nextPhraseText={liveQueueSummary.nextQueuedText}
            onSessionActiveChange={setVideoSessionActive}
            onSessionPhaseChange={setVideoSessionPhase}
            onSessionReset={() => {
              resetSession('idle');
              setLatestLivePhrase('');
              setAppError(null);
            }}
            onTranscriptEvent={handleLiveTranscriptEvent}
            playbackState={playbackState}
            queuedPhraseCount={liveQueueSummary.queuedCount}
          />
        ) : videoId ? (
          <section className="panel panel-video" aria-label="Video preview panel">
            <div className="panel-section-header">
              <div className="panel-section-copy">
                <p className="panel-section-label">Source video (from YouTube)</p>
              </div>
            </div>

            <div className="video-stage">
              <div className="video-frame">
                <div id="player" className="yt-player" />
              </div>
            </div>
          </section>
        ) : null}

        <SkeletonViewerPanel
          activeIndex={activeIndex}
          allowTranscriptToggle={Boolean(videoId) || activeMode === 'groq'}
          chunks={chunks}
          error={appError}
          liveMode={activeMode === 'video'}
          liveQueuedCount={liveQueueSummary.queuedCount}
          liveSignedText={liveQueueSummary.currentText}
          liveStatusLabel={viewerStatusLabel}
          nextQueuedText={liveQueueSummary.nextQueuedText}
          onVisibleViewerEnded={handleVisibleViewerEnded}
          onVisibleViewerError={handleVisibleViewerError}
          onVisibleViewerReady={handleVisibleViewerReady}
          onVisibleViewerRef={handleVisibleViewerRef}
          playbackState={playbackState}
          visibleChunkIndex={visibleChunkIndex}
          visiblePoseSrc={visiblePoseSrc}
        />
      </main>
    </div>
  );
}

export default App;
