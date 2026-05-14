/**
 * Loom transcript segments come as an array of `{ start, end, speaker,
 * text }` objects (or similar shapes across API versions). This helper
 * folds consecutive segments by the same speaker and emits speaker-
 * prefixed lines that pipeline-meeting can parse.
 *
 * Accepts either:
 *  - `[{ speaker, text, start? }]`
 *  - a flat array of `{ text }` when no speaker diarization is available
 *  - a plain string (already-formatted transcript) — passed through
 */

export interface TranscriptSegment {
  text: string;
  speaker?: string | null;
  start?: number | null;
  end?: number | null;
}

export function transcriptToMarkdown(
  input: TranscriptSegment[] | string | null | undefined,
): string {
  if (!input) return "";
  if (typeof input === "string") return input.trim();
  if (!Array.isArray(input) || input.length === 0) return "";

  const lines: string[] = [];
  let currentSpeaker: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const prefix = currentSpeaker ? `${currentSpeaker}: ` : "";
    lines.push(`${prefix}${buffer.join(" ").replace(/\s+/g, " ").trim()}`);
    buffer = [];
  };

  for (const seg of input) {
    const speaker = (seg.speaker ?? "").trim() || null;
    const text = (seg.text ?? "").trim();
    if (!text) continue;

    if (speaker !== currentSpeaker) {
      flush();
      currentSpeaker = speaker;
    }
    buffer.push(text);
  }
  flush();

  return lines.join("\n");
}
