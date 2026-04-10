import { useEffect, useRef, useState } from 'react';
import { SkeletonViewerPanel } from './components/SkeletonViewerPanel';
import { TextInputPanel } from './components/TextInputPanel';
import { buildBackendUrl } from './lib/backend';
import { buildPoseUrl } from './lib/translation';
import { parseSRT } from './lib/subtitleParser';

type Chunk = {
  start: number;
  end: number;
  text: string;
};

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
  const [poseUrl, setPoseUrl] = useState<string | null>(null);
  const [queue, setQueue] = useState<Chunk[]>([]);
  const [index, setIndex] = useState(0);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [activeText, setActiveText] = useState<string | null>(null);
  const [segmentHoldMs, setSegmentHoldMs] = useState(0);
  const [runToken, setRunToken] = useState(0);

  const playerRef = useRef<any>(null);
  const [ytReady, setYtReady] = useState(false);

  useEffect(() => {
    if ((window as any).YT) {
      setYtReady(true);
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';

    (window as any).onYouTubeIframeAPIReady = () => {
      setYtReady(true);
    };

    document.body.appendChild(tag);
  }, []);

  useEffect(() => {
    if (!videoId || !ytReady) return;

    setPlayerReady(false);

    if (playerRef.current && typeof playerRef.current.destroy === 'function') {
      playerRef.current.destroy();
    }

    playerRef.current = new (window as any).YT.Player('player', {
      videoId,
      events: {
        onReady: () => setPlayerReady(true),
        onError: () => {
          setPlayerReady(false);
          setAppError('Could not load the YouTube player for this link.');
        },
      },
    });
  }, [videoId, ytReady]);

  const pushQueue = (chunks: Chunk[], shouldShowVideo: boolean) => {
    setAppError(null);
    setQueue(chunks);
    setIndex(0);
    setActiveText(chunks[0]?.text ?? null);

    if (!shouldShowVideo) {
      setVideoId(null);
    }
  };

  const handleSubmit = async ({
    text,
    videoUrl,
    fileContent,
    fileType,
  }: {
    text: string;
    videoUrl: string;
    fileContent: string;
    fileType: 'vtt' | 'srt' | null;
  }) => {
    setRunToken(prev => prev + 1);
    setAppError(null);

    if (videoUrl) {
      const res = await fetch(
        `${buildBackendUrl('/download')}?url=${encodeURIComponent(videoUrl)}`
      );

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

      if (!subtitleRes.ok) {
        throw new Error(
          await getResponseErrorMessage(
            subtitleRes,
            'Could not fetch subtitle file from backend.'
          )
        );
      }

      const subtitleText = await subtitleRes.text();
      const parsed = parseSRT(subtitleText);

      if (parsed.length === 0) {
        throw new Error('Subtitle file was empty or could not be parsed.');
      }

      setVideoId(data.video_id);
      setSegmentHoldMs(10000);
      pushQueue(parsed, true);
      return;
    }

    if (fileContent) {
      const parsed = parseSRT(fileContent);

      if (parsed.length === 0) {
        throw new Error('Subtitle file was empty or could not be parsed.');
      }

      setSegmentHoldMs(10000);
      pushQueue(parsed, false);
      return;
    }

    if (text) {
      const textChunk = {
        start: 0,
        end: Math.max(4, Math.min(10, Math.ceil(text.length / 12))),
        text,
      };

      setSegmentHoldMs(10000);
      pushQueue([textChunk], false);
      return;
    }

    throw new Error('Add some text, subtitle content, or a YouTube link first.');
  };

  const handleClear = () => {
    setPoseUrl(null);
    setQueue([]);
    setIndex(0);
    setVideoId(null);
    setPlayerReady(false);
    setAppError(null);
    setActiveText(null);
  };

  useEffect(() => {
    if (queue.length === 0) return;
    if (index >= queue.length) return;

    const chunk = queue[index];

    const url = new URL(buildPoseUrl(chunk.text, 'en', 'ase'));
    url.searchParams.set('run', String(runToken));
    url.searchParams.set('segment', String(index));
    setPoseUrl(url.toString());
    setActiveText(chunk.text);

    if (playerRef.current && playerReady) {
      playerRef.current.seekTo(chunk.start, true);
      playerRef.current.playVideo();
    }

    const duration = (chunk.end - chunk.start) * 1000;
    const totalDelay = duration + segmentHoldMs;

    const timer = setTimeout(() => {
      if (playerRef.current && playerReady) {
        playerRef.current.pauseVideo();
      }

      setIndex(prev => prev + 1);
    }, totalDelay);

    return () => clearTimeout(timer);
  }, [index, playerReady, queue, runToken, segmentHoldMs]);

  useEffect(() => {
    return () => {
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        playerRef.current.destroy();
      }
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-controls">
          <TextInputPanel onSubmit={handleSubmit} onClear={handleClear} />
        </div>
      </header>

      <main
        className={
          videoId
            ? 'translation-grid translation-grid-single-screen'
            : 'translation-grid translation-grid-single-screen translation-grid-no-video'
        }
      >
        {videoId ? (
          <section className="panel panel-video" aria-label="Video preview panel">
            <div className="video-frame">
              <div id="player" className="yt-player" />
            </div>
          </section>
        ) : null}

        <SkeletonViewerPanel
          src={poseUrl}
          loading={false}
          error={appError}
          captionText={activeText}
        />
      </main>
    </div>
  );
}

export default App;
