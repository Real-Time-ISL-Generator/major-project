export interface SubtitleChunk {
  start: number;
  end: number;
  text: string;
}

// Convert time (HH:MM:SS,ms) → seconds
function toSeconds(time: string): number {
  const clean = time.trim().replace(",", ".");
  const parts = clean.split(":");

  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);

  return h * 3600 + m * 60 + s;
}

// Parse SRT format
export function parseSRT(data: string): SubtitleChunk[] {
  const normalized = data
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/^WEBVTT[^\n]*\n+/i, "");

  const blocks = normalized.split(/\n{2,}/);

  return blocks
    .map(block => {
      const lines = block
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);

      if (lines.length < 2) return null;

      const timeLineIndex = lines.findIndex(line => line.includes(" --> "));
      if (timeLineIndex === -1) return null;

      const timeLine = lines[timeLineIndex];
      const text = lines.slice(timeLineIndex + 1).join(" ");

      const [start, end] = timeLine.split(" --> ");

      if (!start || !end || !text) return null;

      return {
        start: toSeconds(start.trim()),
        end: toSeconds(end.trim()),
        text: text.trim()
      };
    })
    .filter(Boolean) as SubtitleChunk[];
}