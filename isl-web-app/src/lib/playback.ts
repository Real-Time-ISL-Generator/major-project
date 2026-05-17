import {buildPoseUrl} from './translation';
import type {RawSubtitleCue} from './subtitleParser';

export type VisibleChunkStatus = 'idle' | 'binding' | 'ready';
export type PlaybackSourceMode = 'youtube' | 'text' | 'file' | 'video' | 'groq';
export type TranscriptState = 'interim' | 'final';
export type QueueStatus = 'pending' | 'ready' | 'playing' | 'played' | 'error';

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
  sourceMode: PlaybackSourceMode;
  transcriptState: TranscriptState;
  createdAtMs: number;
  speechStartMs: number | null;
  speechEndMs: number | null;
  queueStatus: QueueStatus;
}

function clampDuration(duration: number): number {
  return Math.max(0, duration);
}

function estimateTextDuration(text: string): number {
  return Math.max(1.2, Math.min(8.5, Math.ceil(text.trim().length / 14)));
}

type CreatePlaybackChunkInput = {
  id: string;
  text: string;
  start: number;
  end: number;
  sourceMode: PlaybackSourceMode;
  transcriptState?: TranscriptState;
  createdAtMs?: number;
  speechStartMs?: number | null;
  speechEndMs?: number | null;
  queueStatus?: QueueStatus;
};

export function createPlaybackChunk({
  id,
  text,
  start,
  end,
  sourceMode,
  transcriptState = 'final',
  createdAtMs = Date.now(),
  speechStartMs = null,
  speechEndMs = null,
  queueStatus = 'ready',
}: CreatePlaybackChunkInput): PlaybackChunk {
  return {
    id,
    text,
    start,
    end,
    videoDuration: clampDuration(end - start),
    poseUrl: buildPoseUrl(text, 'en', 'ase'),
    poseDuration: null,
    visibleStatus: 'idle',
    error: null,
    sourceMode,
    transcriptState,
    createdAtMs,
    speechStartMs,
    speechEndMs,
    queueStatus,
  };
}

export function createPlaybackChunks(
  cues: RawSubtitleCue[],
  sourceMode: PlaybackSourceMode = 'youtube'
): PlaybackChunk[] {
  return cues.map((cue, index) =>
    createPlaybackChunk({
      id: `chunk-${index}`,
      text: cue.text,
      start: cue.start,
      end: cue.end,
      sourceMode,
    })
  );
}

export function createTextPlaybackChunks(text: string): PlaybackChunk[] {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return [];
  }

  const duration = Math.max(3.5, Math.min(9, Math.ceil(trimmedText.length / 14)));
  return createPlaybackChunks(
    [
      {
        start: 0,
        end: duration,
        text: trimmedText,
      },
    ],
    'text'
  );
}

export function createGroqPlaybackChunks(text: string): PlaybackChunk[] {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return [];
  }

  const duration = Math.max(2, Math.min(5, Math.ceil(trimmedText.length / 16)));
  return createPlaybackChunks(
    [
      {
        start: 0,
        end: duration,
        text: trimmedText,
      },
    ],
    'groq'
  );
}

type LivePlaybackChunkInput = {
  id: string;
  text: string;
  createdAtMs: number;
  speechStartMs?: number | null;
  speechEndMs?: number | null;
};

export function createLivePlaybackChunk({
  id,
  text,
  createdAtMs,
  speechStartMs = null,
  speechEndMs = null,
}: LivePlaybackChunkInput): PlaybackChunk {
  const trimmedText = text.trim();
  const speechDurationSeconds =
    speechStartMs !== null && speechEndMs !== null && speechEndMs > speechStartMs
      ? (speechEndMs - speechStartMs) / 1000
      : estimateTextDuration(trimmedText);

  return createPlaybackChunk({
    id,
    text: trimmedText,
    start: 0,
    end: speechDurationSeconds,
    sourceMode: 'video',
    transcriptState: 'final',
    createdAtMs,
    speechStartMs,
    speechEndMs,
    queueStatus: 'pending',
  });
}
