import { z } from "zod";
import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { ingestContent } from "./ingest-content.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Local repo path. Phase 2 = local only; remote clone is a follow-up. */
  path: z.string().min(1),
  project: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /**
   * Per-file size cap. Files larger than this get skipped (recorded in
   * `errors`). Default 256 KiB — enough for almost any source file,
   * small enough to keep huge generated artifacts (lockfiles, minified
   * bundles, fixtures) from blowing the chunk budget.
   */
  maxFileBytes: z.number().int().positive().default(256 * 1024),
  /**
   * Hard cap on the total number of files visited per call. Prevents a
   * runaway recursion through node_modules-shaped trees. Default 2000.
   */
  maxFiles: z.number().int().positive().default(2_000),
  /**
   * Override the default ignore set when present. Otherwise the defaults
   * (node_modules, .git, dist, build, .next, .turbo, target, etc.) apply.
   */
  ignoreDirs: z.array(z.string()).optional(),
});

interface FileResult {
  source_id: string;
  ingested: number;
  bytes: number;
  type: string;
}

interface Output {
  /** Number of source files that produced at least one chunk. */
  filesIngested: number;
  /** Sum of chunks across every file. */
  chunksIngested: number;
  /** Files visited but skipped (oversize, unreadable, unsupported extension). */
  filesSkipped: number;
  filesByType: Record<string, number>;
  totalBytes: number;
  /** Per-file partial results — capped at 50 entries to keep payloads sane. */
  files: FileResult[];
  /** Per-file errors — capped at 50 entries. */
  errors: Array<{ source_id: string; error: string }>;
  /** True when the walk stopped because maxFiles was hit. */
  truncated: boolean;
}

/**
 * Default ignore set. Anything matching one of these names at any depth
 * gets skipped (folder pruned, never recursed). Tuned for the JS/TS/Go/
 * Python/Rust ecosystems we expect to see most often.
 */
const DEFAULT_IGNORE_DIRS = new Set<string>([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".vercel",
  ".netlify",
  "target", // rust + java
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  "venv",
  ".venv",
  "vendor",
  "coverage",
  ".idea",
  ".vscode",
]);

/**
 * Code-y extensions Cortex knows how to chunk well. The doc pipeline
 * also handles `.md` / `.txt` / `.rst` for prose. Anything outside these
 * sets is skipped (recorded in `errors` with reason="unsupported-extension").
 */
const CODE_EXTS = new Set<string>([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".swift", ".cpp", ".c", ".h", ".hpp", ".cs",
  ".php", ".sh", ".bash", ".zsh", ".sql",
]);

const DOC_EXTS = new Set<string>([
  ".md", ".markdown", ".txt", ".rst", ".adoc", ".org",
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
  ".java": "java", ".kt": "kotlin", ".swift": "swift",
  ".cpp": "cpp", ".c": "c", ".h": "c", ".hpp": "cpp",
  ".cs": "csharp", ".php": "php",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".sql": "sql",
};

/**
 * Walk a local repo, ingest each readable source file into Cortex.
 *
 * Phase 2 scope: LOCAL paths only. Remote clone (git URL → tmpdir →
 * walk → cleanup) is a follow-up; users with private repos can clone
 * themselves and point this at the working tree.
 *
 * The walk is breadth-first on directories. Default ignore set prunes
 * common build/output dirs. `maxFiles` is a hard ceiling that aborts
 * the walk when hit (recorded in `truncated`).
 */
export const ingestRepo: McpTool<typeof inputSchema, Output> = {
  name: "ingest_repo",
  description:
    "Walk a local repository and ingest every readable source file into " +
    "Cortex. Path must exist on the cortex process's filesystem. Skips " +
    "node_modules / .git / dist / build / similar by default; binary " +
    "files and unsupported extensions are skipped (recorded in `errors`). " +
    "Caps at maxFiles=2000 by default — bumps the cap if you really need " +
    "to ingest a huge tree, but consider a more targeted ingest_file run.",
  inputSchema,

  async handler(input, ctx) {
    const root = path.resolve(input.path);
    const rootInfo = await stat(root).catch(() => null);
    if (!rootInfo || !rootInfo.isDirectory()) {
      throw new Error(`ingest_repo: ${root} is not a directory`);
    }
    const ignore = new Set<string>(
      input.ignoreDirs ?? Array.from(DEFAULT_IGNORE_DIRS),
    );

    const files: FileResult[] = [];
    const errors: Array<{ source_id: string; error: string }> = [];
    const filesByType: Record<string, number> = {};
    let chunksIngested = 0;
    let filesIngested = 0;
    let filesSkipped = 0;
    let totalBytes = 0;
    let visited = 0;
    let truncated = false;

    // BFS queue. Each entry is an absolute directory path.
    const queue: string[] = [root];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        errors.push({ source_id: dir, error: (err as Error).message });
        continue;
      }
      for (const name of entries) {
        if (ignore.has(name)) continue;
        if (visited >= input.maxFiles) {
          truncated = true;
          break;
        }
        const abs = path.join(dir, name);
        let info;
        try {
          info = await stat(abs);
        } catch (err) {
          errors.push({ source_id: abs, error: (err as Error).message });
          continue;
        }
        if (info.isDirectory()) {
          queue.push(abs);
          continue;
        }
        if (!info.isFile()) continue;
        visited += 1;

        if (info.size === 0) {
          filesSkipped += 1;
          continue;
        }
        if (info.size > input.maxFileBytes) {
          filesSkipped += 1;
          if (errors.length < 50) {
            errors.push({
              source_id: abs,
              error: `oversize ${info.size} > ${input.maxFileBytes}`,
            });
          }
          continue;
        }

        const ext = path.extname(abs).toLowerCase();
        const isCode = CODE_EXTS.has(ext);
        const isDoc = DOC_EXTS.has(ext);
        if (!isCode && !isDoc) {
          filesSkipped += 1;
          continue;
        }

        let content: string;
        try {
          content = await readFile(abs, "utf8");
        } catch (err) {
          errors.push({ source_id: abs, error: (err as Error).message });
          continue;
        }

        const fileType = isCode ? "code" : "doc";
        const language = isCode ? LANGUAGE_BY_EXT[ext] : undefined;
        const fileTags = language
          ? [...input.tags, `language:${language}`]
          : input.tags;
        const relPath = path.relative(root, abs);

        try {
          const inner = await ingestContent.handler(
            {
              content,
              project: input.project,
              type: fileType,
              sourceId: abs,
              title: relPath,
              sourceUrl: `file://${abs}`,
              source: "manual",
              authors: [],
              tags: fileTags,
            },
            ctx,
          );
          chunksIngested += inner.ingested ?? 0;
          if ((inner.ingested ?? 0) > 0) {
            filesIngested += 1;
            filesByType[fileType] = (filesByType[fileType] ?? 0) + 1;
            totalBytes += info.size;
            if (files.length < 50) {
              files.push({
                source_id: abs,
                ingested: inner.ingested ?? 0,
                bytes: info.size,
                type: fileType,
              });
            }
          } else {
            filesSkipped += 1;
          }
          if (Array.isArray(inner.errors) && inner.errors.length > 0 && errors.length < 50) {
            errors.push(...inner.errors.slice(0, 50 - errors.length));
          }
        } catch (err) {
          if (errors.length < 50) {
            errors.push({ source_id: abs, error: (err as Error).message });
          }
        }
      }
      if (truncated) break;
    }

    return {
      filesIngested,
      chunksIngested,
      filesSkipped,
      filesByType,
      totalBytes,
      files,
      errors,
      truncated,
    };
  },
};
