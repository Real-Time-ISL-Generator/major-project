import {buildPoseUrl} from './translation';
import type {RawSubtitleCue} from './subtitleParser';

export type VisibleChunkStatus = 'idle' | 'binding' | 'ready';

export type PlaybackState =
  | 'idle'
  | 'loadingSource'
  | 'chunking'
  | 'preparingInitialChunks'
  | 'bindingVisibleChunk'
  | 'ready'
  | 'playing'
  | 'completed'
  | 'error';

export interface PlaybackChunk {
  id: string;
  text: string;
  start: number;
  end: number;
  videoDuration: number;
  poseUrl: string;
  poseDuration: number | null;
  visibleStatus: VisibleChunkStatus;
  error: string | null;
}

function clampDuration(duration: number): number {
  return Math.max(0, duration);
}

export function createPlaybackChunks(cues: RawSubtitleCue[]): PlaybackChunk[] {
  return cues.map((cue, index) => ({
    id: `chunk-${index}`,
    text: cue.text,
    start: cue.start,
    end: cue.end,
    videoDuration: clampDuration(cue.end - cue.start),
    poseUrl: buildPoseUrl(cue.text, 'en', 'ase'),
    poseDuration: null,
    visibleStatus: 'idle',
    error: null,
  }));
}

export function createTextPlaybackChunks(text: string): PlaybackChunk[] {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return [];
  }

  const duration = Math.max(3.5, Math.min(9, Math.ceil(trimmedText.length / 14)));
  return createPlaybackChunks([
    {
      start: 0,
      end: duration,
      text: trimmedText,
    },
  ]);
}
