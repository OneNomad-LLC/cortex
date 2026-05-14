import { z } from "zod";
import { readdir, stat, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ingestContent } from "./ingest-content.js";
import { jobs } from "../jobs.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /**
   * Repo source. Either:
   *   - Local path (relative or absolute) → walk in place.
   *   - Git URL (https://host/path[.git], git@host:path, ssh://...)
   *     → shallow-clone to a tmpdir, walk, cleanup. Requires `git`
   *     on PATH.
   * Detection is by isGitUrl(); when ambiguous (e.g. a path that
   * happens to look like a URL), local-path interpretation wins.
   */
  path: z.string().min(1),
  /** Project slug. Optional — defaults to the sentinel "default" project,
   *  the same Phase 1D-friendly fallback that ingest_content uses. */
  project: z.string().min(1).default("default"),
  tags: z.array(z.string()).default([]),
  /**
   * Branch / ref to clone. Only honored for git-URL inputs. Default
   * = the repo's HEAD (whatever the remote points at).
   */
  branch: z.string().optional(),
  /**
   * Per-clone timeout in milliseconds. Aborts a slow clone. Default
   * 5 minutes — generous for a shallow clone of a typical repo;
   * pathological repos with binary blobs in history get killed.
   */
  cloneTimeoutMs: z.number().int().positive().default(5 * 60 * 1000),
  /**
   * Run in the background and return a jobId immediately. Default
   * false (preserves the existing synchronous shape for any pre-
   * async caller). When true, the response is `{ jobId, queued: true }`
   * and the caller polls `kb_job_status({ jobId })` for progress +
   * the eventual result. Useful for repos large enough that the
   * synchronous path ties up the MCP transport noticeably.
   */
  async: z.boolean().default(false),
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
  /** Resolved local path the walk ran against. For git-URL inputs this
   *  is the tmpdir clone destination (already cleaned up by the time
   *  the result is returned). */
  resolvedPath: string;
  /** True when the input was detected as a git URL and shallow-cloned. */
  cloned: boolean;
  /** When cloned: the URL that was cloned. Useful for the renderer's
   *  "ingested github.com/foo/bar" display. */
  source?: string;
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
 * Detect a git remote URL. Recognized shapes:
 *   - https?://...                 (any host; shallow-clones via HTTPS)
 *   - git@host:owner/repo[.git]    (SSH)
 *   - ssh://git@host[:port]/...    (SSH)
 *   - git://host/...               (unauthenticated, rare)
 *
 * A bare github.com URL without scheme would be ambiguous — it could
 * be a path. We require an explicit scheme or `git@` prefix to avoid
 * misclassifying a local path that happens to contain "github.com".
 */
export function isGitUrl(input: string): boolean {
  if (/^(?:https?|ssh|git):\/\//i.test(input)) return true;
  if (/^git@[\w.-]+:[\w./-]+/.test(input)) return true;
  return false;
}

/**
 * Run `git clone --depth=1 [--branch <ref>] <url> <dest>`. Caller is
 * responsible for the tmpdir lifecycle. Throws on non-zero exit, on
 * timeout, or when `git` isn't on PATH.
 */
export async function shallowClone(args: {
  url: string;
  dest: string;
  branch?: string;
  timeoutMs: number;
}): Promise<void> {
  const cmdArgs = ["clone", "--depth=1"];
  if (args.branch) cmdArgs.push("--branch", args.branch);
  cmdArgs.push(args.url, args.dest);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* child may already be dead */ }
      settle(new Error(`git clone timed out after ${args.timeoutMs}ms`));
    }, args.timeoutMs);
    child.stderr?.on("data", (d) => {
      // Cap retained stderr so a noisy clone (lots of progress lines)
      // doesn't balloon memory.
      if (stderr.length < 8 * 1024) stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      settle(new Error(`git clone failed to spawn: ${err.message}${err.message.includes("ENOENT") ? " — is git on PATH?" : ""}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) settle(null);
      else settle(new Error(`git clone exited ${code}: ${stderr.trim() || "(no stderr)"}`));
    });
  });
}

/**
 * Walk a local repo OR shallow-clone a git URL and walk the result.
 *
 * For git URLs the clone lands in an OS tmpdir (mkdtemp prefix
 * `cortex-ingest-repo-`) and is rm -rf'd in the finally block, so a
 * crash mid-walk never leaks the working tree.
 *
 * The walk is breadth-first on directories. Default ignore set prunes
 * common build/output dirs. `maxFiles` is a hard ceiling that aborts
 * the walk when hit (recorded in `truncated`).
 */
export const ingestRepo: McpTool<typeof inputSchema, Output> = {
  name: "ingest_repo",
  description:
    "Walk a repository and ingest every readable source file into Cortex. " +
    "`path` accepts either a local directory OR a git URL (https / ssh / " +
    "git@) — git URLs are shallow-cloned to a tmpdir, walked, and cleaned " +
    "up. Skips node_modules / .git / dist / build / similar by default. " +
    "Caps at maxFiles=2000 by default. Set `branch` to clone a specific " +
    "ref (git URL inputs only). Requires `git` on PATH for clones.",
  inputSchema,

  async handler(input, ctx) {
    // Async opt-in: register a job, kick off the work in the background,
    // return the jobId immediately. The caller polls kb_job_status for
    // the eventual result. Synchronous behavior preserved when async=false
    // (default) so existing callers see no change.
    if (input.async) {
      const job = jobs.create({ kind: "ingest_repo" });
      void runIngestRepo(input, ctx)
        .then((result) => jobs.complete(job.id, result))
        .catch((err) => jobs.fail(job.id, err));
      jobs.start(job.id);
      return {
        // Match the synchronous Output shape's required fields with
        // safe placeholders. Renderers that already handle the sync
        // shape can ignore unknown jobId/queued; renderers that opt
        // into async use those to start polling.
        resolvedPath: "",
        cloned: false,
        filesIngested: 0,
        chunksIngested: 0,
        filesSkipped: 0,
        filesByType: {},
        totalBytes: 0,
        files: [],
        errors: [],
        truncated: false,
        // Signal fields the renderer keys off when async=true.
        jobId: job.id,
        queued: true,
      } as Output & { jobId: string; queued: boolean };
    }
    return runIngestRepo(input, ctx);
  },
};

/**
 * Synchronous ingest_repo body, extracted so the async opt-in can run
 * the same code path without duplicating logic.
 */
async function runIngestRepo(
  input: z.infer<typeof inputSchema>,
  ctx: Parameters<typeof ingestContent.handler>[1],
): Promise<Output> {
  let cloned = false;
  let cloneTmpDir: string | null = null;
  let walkRoot: string;
  let cloneSource: string | undefined;
  if (isGitUrl(input.path)) {
    cloneTmpDir = await mkdtemp(path.join(tmpdir(), "cortex-ingest-repo-"));
    cloneSource = input.path;
    try {
      await shallowClone({
        url: input.path,
        dest: cloneTmpDir,
        ...(input.branch ? { branch: input.branch } : {}),
        timeoutMs: input.cloneTimeoutMs,
      });
    } catch (err) {
      // Clone failed — clean up the tmpdir we created and surface.
      try { await rm(cloneTmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      throw err;
    }
    cloned = true;
    walkRoot = cloneTmpDir;
  } else {
    walkRoot = path.resolve(input.path);
  }

  try {
    return await walkAndIngest({
      ...input,
      resolvedPath: walkRoot,
      cloned,
      ...(cloneSource ? { source: cloneSource } : {}),
    }, ctx);
  } finally {
    if (cloneTmpDir) {
      try { await rm(cloneTmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}

async function walkAndIngest(
  args: z.infer<typeof inputSchema> & { resolvedPath: string; cloned: boolean; source?: string },
  ctx: Parameters<typeof ingestContent.handler>[1],
): Promise<Output> {
  const input = args;
  {
    const root = args.resolvedPath;
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
      resolvedPath: args.resolvedPath,
      cloned: args.cloned,
      ...(args.source ? { source: args.source } : {}),
      filesIngested,
      chunksIngested,
      filesSkipped,
      filesByType,
      totalBytes,
      files,
      errors,
      truncated,
    };
  }
}
