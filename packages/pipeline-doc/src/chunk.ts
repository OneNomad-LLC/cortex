export interface DocChunk {
  /** Heading path ["H1", "H2", "H3"]. Empty for preamble content. */
  headingPath: string[];
  /** Body of this section (excludes the heading line). Trimmed. */
  content: string;
  /** Character offset in the original content. */
  offset: number;
}

/**
 * Chunk markdown-style content by ATX heading hierarchy. Each heading
 * starts a new chunk; body text inside accumulates into that chunk.
 *
 * Rules:
 * - `# H1` resets the path to length 1
 * - `## H2` replaces position 2, keeps H1
 * - Content before any heading becomes the "preamble" chunk with an
 *   empty headingPath
 * - Consecutive empty chunks are dropped
 *
 * Deliberately simple: no table/code-fence handling, no alt heading
 * styles. Good enough for Confluence / Notion / Obsidian output.
 */
export function chunkByHeading(source: string): DocChunk[] {
  const lines = source.split(/\r?\n/);
  const chunks: DocChunk[] = [];
  const path: string[] = [];
  let buffer: string[] = [];
  let chunkOffset = 0;
  let cursor = 0;
  let currentHeadingPath: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const content = buffer.join("\n").trim();
    if (content.length === 0 && currentHeadingPath.length === 0) return;
    chunks.push({
      headingPath: [...currentHeadingPath],
      content,
      offset: chunkOffset,
    });
    buffer = [];
  };

  for (const line of lines) {
    // Respect fenced code blocks so `# stuff` inside ``` doesn't get read
    // as a heading.
    if (/^```/.test(line)) {
      inFence = !inFence;
      buffer.push(line);
      cursor += line.length + 1;
      continue;
    }

    const heading = !inFence ? parseHeading(line) : null;
    if (heading) {
      // New section: flush previous buffer with the previous path.
      flush();
      chunkOffset = cursor;
      // Adjust path depth.
      path.length = heading.level - 1;
      path[heading.level - 1] = heading.text;
      currentHeadingPath = [...path];
    } else {
      buffer.push(line);
    }
    cursor += line.length + 1;
  }

  // Final flush.
  flush();
  return chunks;
}

/** Parse an ATX heading (# through ######). Returns null if not a heading. */
function parseHeading(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
  if (!m) return null;
  const levelStr = m[1];
  const text = m[2];
  if (!levelStr || text === undefined) return null;
  return { level: levelStr.length, text };
}
