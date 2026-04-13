export interface RawSubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface SemanticChunkOptions {
  maxChars?: number;
  maxDuration?: number;
  maxGap?: number;
}

const DEFAULT_CHUNK_OPTIONS: Required<SemanticChunkOptions> = {
  maxChars: 96,
  maxDuration: 7.5,
  maxGap: 0.85,
};

const OVERLAP_EPSILON = 0.001;

function parseTimestamp(value: string): number | null {
  const clean = value.trim().replace(',', '.');
  const timeMatch = clean.match(/^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/);

  if (!timeMatch) {
    return null;
  }

  const [, hoursPart, minutesPart, secondsPart] = timeMatch;
  const hours = Number(hoursPart ?? 0);
  const minutes = Number(minutesPart);
  const seconds = Number(secondsPart);

  if ([hours, minutes, seconds].some(Number.isNaN)) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function normalizeCueText(lines: string[]): string {
  return lines
    .map(line =>
      line
        .replace(/<[^>]+>/g, ' ')
        .replace(/\{\\[^}]+\}/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .trim()
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSubtitleCues(data: string): RawSubtitleCue[] {
  const normalized = data
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/^WEBVTT[^\n]*\n+/i, '')
    .replace(/^NOTE[^\n]*(?:\n(?!\n).*)*\n*/gim, '');

  const blocks = normalized.split(/\n{2,}/);

  const parsedCues = blocks
    .map(block => {
      const lines = block
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

      if (lines.length < 2) {
        return null;
      }

      const timeLineIndex = lines.findIndex(line => line.includes('-->'));
      if (timeLineIndex === -1) {
        return null;
      }

      const timeLine = lines[timeLineIndex];
      const [rawStart, rawEnd] = timeLine.split(/\s+-->\s+/);
      const start = rawStart ? parseTimestamp(rawStart) : null;
      const endToken = rawEnd?.split(/\s+/)[0] ?? '';
      const end = parseTimestamp(endToken);
      const text = normalizeCueText(lines.slice(timeLineIndex + 1));

      if (start === null || end === null || end <= start || !text) {
        return null;
      }

      return {
        start,
        end,
        text,
      };
    })
    .filter((cue): cue is RawSubtitleCue => cue !== null);

  return normalizeSubtitleCues(parsedCues);
}

export function normalizeSubtitleCues(cues: RawSubtitleCue[]): RawSubtitleCue[] {
  if (cues.length === 0) {
    return [];
  }

  const normalized: RawSubtitleCue[] = [];

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const nextCue = cues[index + 1];
    let end = cue.end;

    if (nextCue && nextCue.start < cue.end - OVERLAP_EPSILON) {
      if (nextCue.start <= cue.start + OVERLAP_EPSILON) {
        continue;
      }

      end = nextCue.start;
    }

    if (end <= cue.start + OVERLAP_EPSILON) {
      continue;
    }

    normalized.push({
      ...cue,
      end,
    });
  }

  return normalized;
}

function shouldBreakChunk(
  current: RawSubtitleCue,
  next: RawSubtitleCue,
  options: Required<SemanticChunkOptions>
): boolean {
  const gap = next.start - current.end;
  const combinedText = `${current.text} ${next.text}`.trim();
  const combinedDuration = next.end - current.start;
  const endsSentence = /[.!?…:]\s*$/.test(current.text);
  const endsClause = /[,;]\s*$/.test(current.text);

  if (gap > options.maxGap) {
    return true;
  }

  if (combinedText.length > options.maxChars) {
    return true;
  }

  if (combinedDuration > options.maxDuration) {
    return true;
  }

  if (endsSentence && current.text.length >= 18) {
    return true;
  }

  if (endsClause && gap > options.maxGap / 2 && current.text.length >= 28) {
    return true;
  }

  return false;
}

export function mergeSubtitleCues(
  cues: RawSubtitleCue[],
  options: SemanticChunkOptions = {}
): RawSubtitleCue[] {
  if (cues.length === 0) {
    return [];
  }

  const resolvedOptions = {
    ...DEFAULT_CHUNK_OPTIONS,
    ...options,
  };

  const merged: RawSubtitleCue[] = [];
  let current = {...cues[0]};

  for (let index = 1; index < cues.length; index += 1) {
    const nextCue = cues[index];

    if (shouldBreakChunk(current, nextCue, resolvedOptions)) {
      merged.push(current);
      current = {...nextCue};
      continue;
    }

    current = {
      start: current.start,
      end: nextCue.end,
      text: `${current.text} ${nextCue.text}`.replace(/\s+/g, ' ').trim(),
    };
  }

  merged.push(current);
  return merged;
}

export function parseSRT(data: string): RawSubtitleCue[] {
  return parseSubtitleCues(data);
}
