import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ingestContent } from "./ingest-content.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  path: z.string().min(1),
  project: z.string().min(1),
  /**
   * Optional override. When omitted, `type` is inferred from the file
   * extension (see EXT_TO_TYPE below).
   */
  type: z
    .enum([
      "doc",
      "code",
      "meeting",
      "conversation",
      "note",
      "decision",
      "brief",
      "digest",
    ])
    .optional(),
  title: z.string().default(""),
  tags: z.array(z.string()).default([]),
  /** Fail fast if the file is bigger than this many bytes. Default 1 MiB. */
  maxBytes: z.number().int().positive().default(1_048_576),
});

interface Output {
  ingested: number;
  sourceId: string;
  project: string;
  type: string;
  bytes: number;
  memories: Array<{
    content_preview: string;
    source_id: string;
    title?: string;
  }>;
  /**
   * Per-memory failures from the inner pipeline. Mirrors the
   * `errors` field on `ingest_content.handler` — forwarded here
   * so ingest_file callers see the same partial-success picture.
   */
  errors: Array<{
    source_id: string;
    error: string;
  }>;
}

/**
 * Read a file from the cortex process's filesystem and ingest it.
 *
 * Works when cortex can see the file — typical for `cortex start` on
 * the same host as the file. In a Docker deployment, the path must
 * resolve inside the container; bind-mount the source dir into the
 * compose file or prefer `ingest_content` where Claude does the read.
 */
export const ingestFile: McpTool<typeof inputSchema, Output> = {
  name: "ingest_file",
  description:
    "Read a file from disk and ingest it into Cortex memory. `path` " +
    "must be readable by the cortex process (if running in Docker, " +
    "that means a bind-mounted path). Type is inferred from the " +
    "extension (.md→doc, .ts/.py/etc→code, .txt→doc) unless " +
    "overridden. Prefer `ingest_content` when cortex is containerized " +
    "and Claude is on the host — Claude does the read, passes the " +
    "string, no shared filesystem needed.",
  inputSchema,

  async handler(input, ctx) {
    const abs = path.resolve(input.path);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`ingest_file: ${abs} is not a regular file`);
    }
    if (info.size > input.maxBytes) {
      throw new Error(
        `ingest_file: ${abs} is ${info.size} bytes, exceeds maxBytes=${input.maxBytes}`,
      );
    }

    const ext = path.extname(abs).toLowerCase();

    // Binary-doc extensions are surfaced with a clear "not yet
    // supported" error rather than reading the bytes as UTF-8 (which
    // would produce garbage chunks that pollute the KB). When a parser
    // dep lands, route from here into a per-extension extractor.
    if (BINARY_DOC_EXTS.has(ext)) {
      throw new Error(
        `ingest_file: ${ext} files require a parser Cortex doesn't yet ship. ` +
        `Convert to .md / .txt first (e.g. via pandoc) or wait for the binary-doc support follow-up. ` +
        `Tracked: cortex/docs/MIGRATION-knowledge-engine.md (Phase 2 deferred items).`,
      );
    }

    const content = await readFile(abs, "utf8");
    const inferredType = input.type ?? inferType(ext);
    const inferredLanguage = LANGUAGE_BY_EXT[ext];

    const tagsWithLanguage =
      inferredType === "code" && inferredLanguage
        ? [...input.tags, `language:${inferredLanguage}`]
        : input.tags;

    const inner = await ingestContent.handler(
      {
        content,
        project: input.project,
        type: inferredType,
        sourceId: abs,
        title: input.title || path.basename(abs),
        sourceUrl: `file://${abs}`,
        // SourceType enum doesn't include a dedicated "local" — stamp
        // these as "manual" since a user deliberately asked Cortex to
        // read the file, same provenance as ingest_content.
        source: "manual",
        authors: [],
        tags: tagsWithLanguage,
      },
      ctx,
    );
    return { ...inner, bytes: info.size };
  },
};

/**
 * Extensions whose contents are binary and need a parser to extract
 * text. Detected up front so we error cleanly instead of reading
 * binary bytes as UTF-8 and producing junk chunks. Wire a parser
 * (pdf-parse, mammoth, etc.) per-extension here when ready.
 */
const BINARY_DOC_EXTS = new Set<string>([
  ".pdf",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".odt",
  ".epub",
]);

const EXT_TO_TYPE: Record<string, z.infer<typeof inputSchema>["type"]> = {
  ".md": "doc",
  ".markdown": "doc",
  ".txt": "doc",
  ".rst": "doc",
  ".adoc": "doc",
  ".org": "doc",
  ".ts": "code",
  ".tsx": "code",
  ".js": "code",
  ".jsx": "code",
  ".mjs": "code",
  ".cjs": "code",
  ".py": "code",
  ".rb": "code",
  ".go": "code",
  ".rs": "code",
  ".java": "code",
  ".kt": "code",
  ".swift": "code",
  ".cpp": "code",
  ".c": "code",
  ".h": "code",
  ".hpp": "code",
  ".cs": "code",
  ".php": "code",
  ".sh": "code",
  ".bash": "code",
  ".zsh": "code",
  ".sql": "code",
};

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".cpp": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
};

type IngestType = NonNullable<z.infer<typeof inputSchema>["type"]>;

function inferType(ext: string): IngestType {
  return (EXT_TO_TYPE[ext] ?? "doc") as IngestType;
}
