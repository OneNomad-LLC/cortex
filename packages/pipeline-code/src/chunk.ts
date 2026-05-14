/**
 * Heuristic chunking for source files. Full tree-sitter parsing is
 * out of scope for v1; this regex-based splitter is "good enough" for
 * producing retrievable chunks in mainstream languages.
 *
 * Strategy:
 *  1. If the file fits under `maxChars`, return it as one chunk.
 *  2. Otherwise split on language-appropriate top-level boundaries
 *     (functions, classes, exports, `def`/`class` in Python, etc.).
 *  3. Any remaining sub-chunk still over `maxChars` gets a
 *     fixed-window split with a small overlap.
 */

export interface CodeChunk {
  content: string;
  /** Best-effort symbol name associated with this chunk, if any. */
  symbol?: string;
  /** 1-indexed starting line. */
  startLine: number;
  endLine: number;
}

export interface ChunkOptions {
  language: string;
  maxChars?: number;
  overlapChars?: number;
}

export function chunkCode(
  content: string,
  opts: ChunkOptions,
): CodeChunk[] {
  const maxChars = opts.maxChars ?? 6_000;
  const overlap = opts.overlapChars ?? 200;

  if (content.length <= maxChars) {
    return [
      {
        content,
        startLine: 1,
        endLine: content.split(/\r?\n/).length,
      },
    ];
  }

  const boundaries = boundariesFor(opts.language, content);
  const semantic = splitAtBoundaries(content, boundaries);

  const out: CodeChunk[] = [];
  for (const chunk of semantic) {
    if (chunk.content.length <= maxChars) {
      out.push(chunk);
      continue;
    }
    out.push(...splitFixedWindow(chunk, maxChars, overlap));
  }
  return out;
}

interface Boundary {
  lineIndex: number; // 0-indexed
  symbol?: string;
}

function boundariesFor(language: string, content: string): Boundary[] {
  const lines = content.split(/\r?\n/);
  const boundaries: Boundary[] = [{ lineIndex: 0 }];

  const patterns = PATTERNS[language] ?? PATTERNS.default ?? [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const { regex, group } of patterns) {
      const match = regex.exec(line);
      if (match) {
        const symbol = group !== undefined ? match[group] : undefined;
        boundaries.push({ lineIndex: i, ...(symbol ? { symbol } : {}) });
        break;
      }
    }
  }

  return boundaries;
}

function splitAtBoundaries(
  content: string,
  boundaries: Boundary[],
): CodeChunk[] {
  const lines = content.split(/\r?\n/);
  const sorted = [...boundaries].sort((a, b) => a.lineIndex - b.lineIndex);
  // De-duplicate adjacent boundaries on the same line. When they collide,
  // prefer the entry WITH a symbol (the sentinel at line 0 has none).
  const unique: Boundary[] = [];
  for (const b of sorted) {
    const prev = unique[unique.length - 1];
    if (!prev || prev.lineIndex !== b.lineIndex) {
      unique.push(b);
    } else if (!prev.symbol && b.symbol) {
      unique[unique.length - 1] = b;
    }
  }

  const out: CodeChunk[] = [];
  for (let i = 0; i < unique.length; i++) {
    const start = unique[i]!.lineIndex;
    const end = i + 1 < unique.length ? unique[i + 1]!.lineIndex : lines.length;
    const slice = lines.slice(start, end).join("\n");
    if (slice.trim().length === 0) continue;
    out.push({
      content: slice,
      ...(unique[i]!.symbol ? { symbol: unique[i]!.symbol } : {}),
      startLine: start + 1,
      endLine: end,
    });
  }
  return out;
}

function splitFixedWindow(
  chunk: CodeChunk,
  maxChars: number,
  overlap: number,
): CodeChunk[] {
  const out: CodeChunk[] = [];
  const lines = chunk.content.split(/\r?\n/);
  let buf: string[] = [];
  let bufChars = 0;
  let chunkStart = chunk.startLine;
  let cursorLine = chunk.startLine;

  const flush = (endLine: number): void => {
    if (buf.length === 0) return;
    out.push({
      content: buf.join("\n"),
      ...(chunk.symbol ? { symbol: chunk.symbol } : {}),
      startLine: chunkStart,
      endLine,
    });
    buf = [];
    bufChars = 0;
  };

  for (const line of lines) {
    const newSize = bufChars + line.length + 1;
    if (newSize > maxChars && buf.length > 0) {
      flush(cursorLine - 1);
      // Carry an overlap window if configured.
      if (overlap > 0 && out.length > 0) {
        const last = out[out.length - 1]!.content;
        const tail = last.slice(Math.max(0, last.length - overlap));
        buf.push(tail);
        bufChars += tail.length;
      }
      chunkStart = cursorLine;
    }
    buf.push(line);
    bufChars += line.length + 1;
    cursorLine++;
  }
  flush(chunk.endLine);
  return out;
}

interface Pattern {
  regex: RegExp;
  /** Which capture group is the symbol name, if any. */
  group?: number;
}

const JS_PATTERNS: Pattern[] = [
  { regex: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/, group: 1 },
  { regex: /^\s*export\s+class\s+(\w+)/, group: 1 },
  { regex: /^\s*class\s+(\w+)/, group: 1 },
  { regex: /^\s*(?:async\s+)?function\s+(\w+)/, group: 1 },
  { regex: /^\s*export\s+const\s+(\w+)/, group: 1 },
];

const PY_PATTERNS: Pattern[] = [
  { regex: /^\s*(?:async\s+)?def\s+(\w+)/, group: 1 },
  { regex: /^\s*class\s+(\w+)/, group: 1 },
];

const GO_PATTERNS: Pattern[] = [
  { regex: /^\s*func\s+(?:\([^)]+\)\s+)?(\w+)/, group: 1 },
  { regex: /^\s*type\s+(\w+)\s+(?:struct|interface)/, group: 1 },
];

const RUST_PATTERNS: Pattern[] = [
  { regex: /^\s*(?:pub\s+(?:\([^)]+\)\s+)?)?fn\s+(\w+)/, group: 1 },
  { regex: /^\s*(?:pub\s+)?struct\s+(\w+)/, group: 1 },
  { regex: /^\s*(?:pub\s+)?enum\s+(\w+)/, group: 1 },
  { regex: /^\s*impl\b/ },
];

const JAVA_PATTERNS: Pattern[] = [
  { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/, group: 1 },
  { regex: /^\s*(?:public\s+)?class\s+(\w+)/, group: 1 },
];

const PATTERNS: Record<string, Pattern[]> = {
  typescript: JS_PATTERNS,
  javascript: JS_PATTERNS,
  python: PY_PATTERNS,
  go: GO_PATTERNS,
  rust: RUST_PATTERNS,
  java: JAVA_PATTERNS,
  kotlin: JAVA_PATTERNS,
  csharp: JAVA_PATTERNS,
  default: JS_PATTERNS,
};
