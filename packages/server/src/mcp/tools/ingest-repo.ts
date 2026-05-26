import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readdir, stat, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  codeDossierPipeline,
  computeInputsSha,
  type CodeDossierInput,
} from "@onenomad/przm-cortex-pipeline-code-dossier";
import {
  memoryMetadataSchema,
  type MemoryMetadata,
} from "@onenomad/przm-cortex-core";
import { buildPipelineContext } from "../../sync.js";
import { ingestContent } from "./ingest-content.js";
import { jobs } from "../jobs.js";
import type { McpTool, ToolContext } from "../tool.js";

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
   * true (the safe default — even small repos can exceed the MCP
   * transport timeout once embeddings + enrichment land, and the
   * client polls `kb_job_status({ jobId })` for progress + the
   * eventual result). Set false ONLY when the caller knows the repo
   * is small (under ~50 files) and wants the result inline; the sync
   * shape is kept for that and for backward-compat with older callers.
   */
  async: z.boolean().default(true),
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
  /**
   * Ingest mode. Picks which pipeline(s) the repo is fed through:
   *
   *   - 'dossier' (default): the new 3-pass code-dossier pipeline
   *     (structural → synthesis → brief). Produces a small set of
   *     high-signal memories that describe the repo (brief, decisions,
   *     references). Matches the user intent "ingest this repo should
   *     give me knowledge ABOUT the code, not the entire codebase".
   *
   *   - 'full': legacy per-file walk. Every readable source file
   *     becomes one or more chunks in engram. High-volume, low-signal —
   *     useful when you actually want byte-level grep across the repo.
   *
   *   - 'both': dossier first (so high-signal memories are queryable
   *     fast), then full (bulk index in the background). Source_id
   *     prefixes differ so the two memory sets don't collide.
   *
   * Default flipped to 'dossier' in 0.6 — the "knowledge ABOUT" intent
   * is the right default for "I just connected a repo, what is it?"
   * The dashboard's mode toggle (Slice D) makes 'full' / 'both' a
   * one-click override.
   */
  mode: z.enum(["dossier", "full", "both"]).default("dossier"),
  /**
   * SHA-gated re-derivation. When true (default) and mode includes
   * 'dossier', the handler computes a SHA over the dossier inputs
   * (file tree + project + tags + sourceUrl) and skips the run when
   * the prior dossier's stored SHA matches. Set false to force a
   * re-run — useful when the pipeline itself was updated and you
   * want fresh memories even though the inputs didn't change.
   *
   * Has no effect on mode='full' (no SHA gate for the bulk index).
   */
  skipIfUnchanged: z.boolean().default(true),
});

interface FileResult {
  source_id: string;
  ingested: number;
  bytes: number;
  type: string;
}

interface Output {
  /** Which mode the call ran. Echoed back so the renderer can pick its
   *  card / progress style without re-reading the request. */
  mode: "dossier" | "full" | "both";
  /** Resolved local path the walk ran against. For git-URL inputs this
   *  is the tmpdir clone destination (already cleaned up by the time
   *  the result is returned). Empty when the SHA gate skipped the run. */
  resolvedPath: string;
  /** True when the input was detected as a git URL and shallow-cloned. */
  cloned: boolean;
  /** When cloned: the URL that was cloned. Useful for the renderer's
   *  "ingested github.com/foo/bar" display. */
  source?: string;
  /** Number of source files that produced at least one chunk. Populated
   *  by the full-walk path only. */
  filesIngested: number;
  /** Sum of chunks across every file. Populated by the full-walk path. */
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
  /**
   * Memory counts by category. `brief` / `decisions` / `references` are
   * populated by the dossier path; `chunks` by the full path. mode='both'
   * fills all four when the SHA gate didn't fire.
   */
  memories: {
    brief?: number;
    decisions?: number;
    references?: number;
    chunks?: number;
  };
  /** Set when the SHA gate matched and the dossier run was skipped.
   *  mode='full' never sets this. */
  skipped?: boolean;
  /** Why the run was skipped — present only when `skipped` is true. */
  skipReason?: string;
  /** Job id that produced the prior dossier — surfaced on a SHA hit
   *  so callers can fetch the prior result without searching. */
  priorJobId?: string;
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
    // Job kind reflects the chosen mode so the dashboard's Jobs view
    // can distinguish "ingested the dossier" from "indexed every file"
    // at a glance. Slice D's mode badge keys off this.
    const jobKind =
      input.mode === "dossier"
        ? "ingest-repo-dossier"
        : input.mode === "both"
          ? "ingest-repo-both"
          : "ingest-repo-full";

    // Async opt-in: register a job, kick off the work in the background,
    // return the jobId immediately. The caller polls kb_job_status for
    // the eventual result. Synchronous behavior preserved when async=false
    // so existing callers see no change.
    if (input.async) {
      const job = jobs.create({
        kind: jobKind,
        ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
      });
      // enqueue() respects the process-wide concurrency cap so two
      // parallel ingests don't OOM the box. Jobs over the cap sit at
      // status='queued' until a slot opens.
      jobs.enqueue(job.id, () => runIngestRepo(input, ctx, job.id));
      return {
        mode: input.mode,
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
        memories: {},
        // Signal fields the renderer keys off when async=true.
        jobId: job.id,
        queued: true,
      } as Output & { jobId: string; queued: boolean };
    }
    return runIngestRepo(input, ctx, null);
  },
};

/**
 * Synchronous ingest_repo body, extracted so the async opt-in can run
 * the same code path without duplicating logic. The mode parameter
 * picks the pipeline(s): dossier (high-signal memories), full (per-file
 * walk), or both. The dossier path runs first when mode='both' so its
 * memories are queryable before the slower full index finishes.
 *
 * `jobId` is non-null when called from the async job runner — the
 * runners use it for progress reporting (`jobs.progress(jobId, ...)`)
 * and stamp it on dossier brief memories so a SHA hit can return
 * `priorJobId`. null on sync calls — progress reporting is a no-op
 * via `reportProgress`, which checks for null.
 */
async function runIngestRepo(
  input: z.infer<typeof inputSchema>,
  ctx: ToolContext,
  jobId: string | null,
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
    const baseArgs = {
      ...input,
      resolvedPath: walkRoot,
      cloned,
      ...(cloneSource ? { source: cloneSource } : {}),
    };

    if (input.mode === "dossier") {
      return await runDossier(baseArgs, ctx, jobId);
    }
    if (input.mode === "full") {
      return await walkAndIngest(baseArgs, ctx, jobId);
    }
    // mode === "both": dossier first (high-signal), then full.
    // Errors in the dossier portion don't block the full portion —
    // the chunks index is still useful even if the brief failed.
    reportProgress(jobId, { phase: "dossier", message: "running dossier pipeline" });
    let dossierOut: Output;
    try {
      dossierOut = await runDossier(baseArgs, ctx, jobId);
    } catch (err) {
      ctx.logger.warn("ingest_repo.both.dossier_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      dossierOut = {
        mode: "both",
        resolvedPath: walkRoot,
        cloned,
        ...(cloneSource ? { source: cloneSource } : {}),
        filesIngested: 0,
        chunksIngested: 0,
        filesSkipped: 0,
        filesByType: {},
        totalBytes: 0,
        files: [],
        errors: [
          {
            source_id: walkRoot,
            error: `dossier failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        truncated: false,
        memories: { brief: 0, decisions: 0, references: 0 },
      };
    }
    reportProgress(jobId, { phase: "full", message: "running full per-file walk" });
    const fullOut = await walkAndIngest(baseArgs, ctx, jobId);

    // Merge: dossier produced memories.brief/decisions/references;
    // full produced everything else. Errors concatenated (cap at 50).
    return {
      mode: "both",
      resolvedPath: walkRoot,
      cloned,
      ...(cloneSource ? { source: cloneSource } : {}),
      filesIngested: fullOut.filesIngested,
      chunksIngested: fullOut.chunksIngested,
      filesSkipped: fullOut.filesSkipped,
      filesByType: fullOut.filesByType,
      totalBytes: fullOut.totalBytes,
      files: fullOut.files,
      errors: [...dossierOut.errors, ...fullOut.errors].slice(0, 50),
      truncated: fullOut.truncated,
      memories: {
        ...dossierOut.memories,
        chunks: fullOut.memories.chunks ?? fullOut.chunksIngested,
      },
    };
  } finally {
    if (cloneTmpDir) {
      try { await rm(cloneTmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}

/**
 * Bridge to the JobRegistry's progress reporter. No-ops when jobId is
 * null (synchronous mode) so the dossier path can call it
 * unconditionally without branching on async at every phase boundary.
 */
function reportProgress(
  jobId: string | null,
  patch: Record<string, unknown>,
): void {
  if (jobId === null) return;
  jobs.progress(jobId, patch);
}

async function walkAndIngest(
  args: z.infer<typeof inputSchema> & { resolvedPath: string; cloned: boolean; source?: string },
  ctx: ToolContext,
  jobId: string | null,
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
      // Mid-walk progress: how many files we've visited so far. The
      // dashboard's Jobs view renders this as a "X / Y" counter when
      // present.
      reportProgress(jobId, {
        phase: "full",
        doneUnits: visited,
        message: `walked ${visited} files`,
      });
    }

    return {
      mode: args.mode === "both" ? "both" : "full",
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
      memories: { chunks: chunksIngested },
    };
  }
}

/**
 * Dossier-mode runner. SHA-gates the run against any prior dossier
 * brief for the same source_id prefix, invokes the code-dossier
 * pipeline when needed, and persists the returned memories via
 * engram. Memory categorization (brief / decisions / references) is
 * read off the pipeline's `metadata.type` field — Slice A's
 * pipeline emits one brief, N decisions, M references.
 *
 * `args.resolvedPath` is the absolute local directory (already
 * cloned if the input was a git URL). The pipeline takes over from
 * there — Slice B doesn't peek inside the tree.
 */
async function runDossier(
  args: z.infer<typeof inputSchema> & { resolvedPath: string; cloned: boolean; source?: string },
  ctx: ToolContext,
  jobId: string | null,
): Promise<Output> {
  // Validate the resolved path before invoking the pipeline — Slice A's
  // run() may not surface a missing-directory error cleanly, and we
  // want the failure to land in the same place as the full-walk's
  // existing precondition check.
  const rootInfo = await stat(args.resolvedPath).catch(() => null);
  if (!rootInfo || !rootInfo.isDirectory()) {
    throw new Error(`ingest_repo: ${args.resolvedPath} is not a directory`);
  }

  // Build the dossier pipeline input. `sourceIdPrefix` is what
  // dedupes a re-run against a prior dossier of the same repo:
  //   - git URL: the clone URL itself (so re-cloning from the same
  //     URL hits the dedupe key)
  //   - local path: `repo:<absolutePath>` (the absolute path is
  //     stable as long as the repo lives in the same place)
  const sourceIdPrefix = args.source ?? `repo:${args.resolvedPath}`;
  const dossierInput: CodeDossierInput = {
    repoPath: args.resolvedPath,
    sourceIdPrefix,
    project: args.project,
    tags: args.tags,
    ...(args.source ? { sourceUrl: args.source } : {}),
  };

  reportProgress(jobId, { phase: "structural", message: "computing inputs SHA" });
  const sha = await computeInputsSha(dossierInput);

  // SHA gate. Search for a prior brief with the same sourceIdPrefix +
  // sha tag combination. A hit means the dossier inputs haven't
  // changed since the last run — skip unless the caller forced a
  // re-derivation via skipIfUnchanged=false.
  if (args.skipIfUnchanged) {
    const prior = await findPriorDossierBrief(ctx, sourceIdPrefix);
    if (prior && prior.sha === sha) {
      ctx.logger.info("ingest_repo.dossier.sha_gate.skipped", {
        sourceIdPrefix,
        sha,
        ...(prior.jobId ? { priorJobId: prior.jobId } : {}),
      });
      reportProgress(jobId, {
        phase: "skipped",
        message: "inputs unchanged since prior dossier",
      });
      return {
        mode: "dossier",
        resolvedPath: args.resolvedPath,
        cloned: args.cloned,
        ...(args.source ? { source: args.source } : {}),
        filesIngested: 0,
        chunksIngested: 0,
        filesSkipped: 0,
        filesByType: {},
        totalBytes: 0,
        files: [],
        errors: [],
        truncated: false,
        memories: { brief: 0, decisions: 0, references: 0 },
        skipped: true,
        skipReason: "unchanged",
        ...(prior.jobId ? { priorJobId: prior.jobId } : {}),
      };
    }
  }

  // No SHA match (or skipIfUnchanged=false) — run the pipeline.
  reportProgress(jobId, { phase: "synthesis", message: "running dossier pipeline" });
  const traceId = ctx.traceId ?? randomUUID();
  const pipelineCtx = buildPipelineContext({
    logger: ctx.logger.child({ tool: "ingest_repo", traceId, mode: "dossier" }),
    traceId,
    signal: new AbortController().signal,
    ...(ctx.llmRouter ? { llmRouter: ctx.llmRouter } : {}),
  });

  const memories = await codeDossierPipeline.run(dossierInput, pipelineCtx);

  reportProgress(jobId, { phase: "brief", message: "persisting dossier memories" });

  // Categorize, stamp the SHA + jobId on the brief, persist. Errors
  // surface per-memory so a single bad write doesn't drop the batch.
  let briefCount = 0;
  let decisionCount = 0;
  let referenceCount = 0;
  const errors: Array<{ source_id: string; error: string }> = [];

  for (const mem of memories) {
    const type = typeof mem.metadata.type === "string" ? mem.metadata.type : "note";
    const existingTags = Array.isArray(mem.metadata.tags) ? mem.metadata.tags : [];

    // Brief memories get the SHA + jobId stamped so a future SHA
    // gate check can match against this run. Other memory types
    // pass through unmodified.
    const extraTags: string[] = [];
    if (type === "brief") {
      extraTags.push(
        `dossier_brief:1`,
        `dossier_source:${sourceIdPrefix}`,
        `inputs_sha:${sha}`,
      );
      if (jobId) extraTags.push(`job_id:${jobId}`);
    }

    const metadata: MemoryMetadata = {
      ...mem.metadata,
      tags: [...existingTags, ...extraTags],
      ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
    };

    const memSourceId =
      typeof metadata.source_id === "string" ? metadata.source_id : sourceIdPrefix;

    const parsed = memoryMetadataSchema.safeParse(metadata);
    if (!parsed.success) {
      ctx.logger.warn("ingest_repo.dossier.metadata_invalid", {
        sourceId: memSourceId,
        traceId,
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      if (errors.length < 50) {
        errors.push({
          source_id: memSourceId,
          error: `metadata contract violation: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")}`,
        });
      }
      continue;
    }

    try {
      await ctx.engram.ingest({ content: mem.content, metadata: parsed.data });
      if (type === "brief") briefCount += 1;
      else if (type === "decision") decisionCount += 1;
      else if (type === "reference") referenceCount += 1;
      // Other types (e.g. note pass-through) still get persisted but
      // don't count toward the named buckets.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (errors.length < 50) errors.push({ source_id: memSourceId, error: msg });
    }
  }

  ctx.logger.info("ingest_repo.dossier.done", {
    sourceIdPrefix,
    sha,
    brief: briefCount,
    decisions: decisionCount,
    references: referenceCount,
    failed: errors.length,
    traceId,
  });

  return {
    mode: "dossier",
    resolvedPath: args.resolvedPath,
    cloned: args.cloned,
    ...(args.source ? { source: args.source } : {}),
    filesIngested: 0,
    chunksIngested: 0,
    filesSkipped: 0,
    filesByType: {},
    totalBytes: 0,
    files: [],
    errors,
    truncated: false,
    memories: {
      brief: briefCount,
      decisions: decisionCount,
      references: referenceCount,
    },
  };
}

/**
 * Look up a prior dossier brief for `sourceIdPrefix` in engram. Reads
 * the recorded `inputs_sha:<sha>` and `job_id:<id>` tags off the
 * brief so the SHA gate can decide whether to re-run and so the
 * skipped response can echo `priorJobId`.
 *
 * Returns null when no prior brief exists. Soft-fails (returns null)
 * on search errors so a broken engram search doesn't block the
 * pipeline — better to spend a few LLM dollars than to silently
 * never re-run because the lookup is wedged.
 */
async function findPriorDossierBrief(
  ctx: ToolContext,
  sourceIdPrefix: string,
): Promise<{ sha: string; jobId?: string } | null> {
  try {
    const candidates = await ctx.engram.search({
      // engram's text search hits content + tags; the source-id
      // prefix is the tightest pre-filter we have.
      query: sourceIdPrefix,
      type: "brief",
      limit: 20,
      ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
    });
    for (const m of candidates) {
      const tags = (m.tags ?? []) as string[];
      if (!tags.includes(`dossier_source:${sourceIdPrefix}`)) continue;
      if (!tags.includes("dossier_brief:1")) continue;
      const shaTag = tags.find((t) => t.startsWith("inputs_sha:"));
      if (!shaTag) continue;
      const sha = shaTag.slice("inputs_sha:".length);
      const jobTag = tags.find((t) => t.startsWith("job_id:"));
      const jobId = jobTag ? jobTag.slice("job_id:".length) : undefined;
      return { sha, ...(jobId ? { jobId } : {}) };
    }
    return null;
  } catch (err) {
    ctx.logger.warn("ingest_repo.dossier.sha_gate.search_failed", {
      sourceIdPrefix,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
