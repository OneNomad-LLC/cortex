export interface ConversationMessage {
  speaker: string;
  text: string;
  /** ISO 8601 if the line carries a timestamp prefix. */
  timestampIso?: string;
}

/**
 * Parse a conversation transcript back into structured messages.
 * Expected shape (what adapters emit):
 *
 *     `[2026-04-22T12:34:00Z] Alex: hello`
 *     `Alex: line 2 without a timestamp`
 *
 * Lines that don't match the pattern are appended to the previous
 * message's text (continuation).
 */
export function parseConversation(text: string): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  const lines = text.split(/\r?\n/);

  const withTs =
    /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)\]\s+([^:]+):\s*(.*)$/;
  const withoutTs = /^([^\s:][^:]{0,80}):\s*(.*)$/;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    const matchTs = withTs.exec(line);
    if (matchTs) {
      const [, ts, speaker, text] = matchTs;
      if (speaker && text !== undefined && ts) {
        out.push({
          speaker: speaker.trim(),
          text: text.trim(),
          timestampIso: ts,
        });
        continue;
      }
    }

    const match = withoutTs.exec(line);
    if (match) {
      const [, speaker, text] = match;
      if (speaker && text !== undefined) {
        out.push({ speaker: speaker.trim(), text: text.trim() });
        continue;
      }
    }

    // Continuation line — append to previous message.
    const prev = out[out.length - 1];
    if (prev) {
      prev.text = `${prev.text}\n${line}`.trim();
    }
  }

  return out;
}

/** Re-emit messages as `Speaker: text` lines (no timestamp). */
export function serializeConversation(messages: ConversationMessage[]): string {
  return messages
    .map((m) => `${m.speaker}: ${m.text}`)
    .join("\n");
}
