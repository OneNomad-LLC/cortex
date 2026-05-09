import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ingestContent } from "./ingest-content.js";
import type { McpTool } from "../tool.js";

/**
 * Lazy import of pdf-parse so the heavy parser only loads when a PDF
 * actually shows up. Keeps cold-start lean for the common .md / .txt
 * path; the dynamic import is cached after the first call.
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  const mod = await import("pdf-parse");
  // pdf-parse exports differ across releases (CJS default vs named).
  // The legacy CJS shape is the default export. Newer ESM shape exposes
  // it under .default too; either way `.default` is the call target.
  type PdfParse = (b: Buffer) => Promise<{ text?: string }>;
  const pdfParse = ((mod as { default?: PdfParse }).default
    ?? (mod as unknown as PdfParse));
  const result = await pdfParse(buffer);
  return result.text ?? "";
}

const inputSchema = z.object({
  path: z.string().min(1),
  /** Project slug. Optional — defaults to the sentinel "default" project,
   *  the same Phase 1D-friendly fallback that ingest_content uses. */
  project: z.string().min(1).default("default"),
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
  /** Fail fast if the file is bigger than this many bytes. Default 5 MiB
   *  — covers most text files comfortably and is large enough for typical
   *  PDFs (technical docs, contracts) without forcing the caller to
   *  override. Bump explicitly for large PDFs / books. */
  maxBytes: z.number().int().positive().default(5 * 1024 * 1024),
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

    // PDF support via lazy-loaded pdf-parse. Other binary doc formats
    // (.docx, .pptx, .xlsx, .odt, .epub) still error cleanly until a
    // per-format extractor lands.
    let content: string;
    if (ext === ".pdf") {
      const buf = await readFile(abs);
      content = await extractPdfText(buf);
      if (!content || content.trim().length === 0) {
        throw new Error(
          `ingest_file: extracted text from ${abs} is empty — the PDF may be scanned (image-only) or use unsupported encoding. Convert to .md / .txt first if you need this content.`,
        );
      }
    } else if (BINARY_DOC_EXTS.has(ext)) {
      throw new Error(
        `ingest_file: ${ext} files require a parser Cortex doesn't yet ship. ` +
        `Convert to .md / .txt first (e.g. via pandoc) or wait for the binary-doc support follow-up. ` +
        `Tracked: cortex/docs/MIGRATION-knowledge-engine.md (Phase 2 deferred items).`,
      );
    } else {
      content = await readFile(abs, "utf8");
    }
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
  // .pdf removed — handled via lazy pdf-parse import above. Other
  // formats still error cleanly with a "not yet supported" message
  // until a per-format extractor lands (mammoth for .docx, etc.).
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
  ".pdf": "doc",
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
