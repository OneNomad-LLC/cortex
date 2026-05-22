import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  Pipeline,
  PipelineContext,
  PipelineMemory,
} from "@onenomad/przm-cortex-pipeline-core";

/**
 * Slice B note (2026-05-22):
 *
 * This package is currently a stub. The real 3-pass LLM extraction
 * (structural → synthesis → brief) is owned by Slice A
 * (pipeline-code-dossier (3-pass LLM extraction)). The interface
 * below is locked — Slice A will replace the stub bodies with real
 * implementations without changing the exported shape.
 *
 * Why a stub: Slice B (ingest_repo `mode` parameter) needs to land
 * the call site, the SHA gate, and the JobRegistry wiring before
 * Slice A merges. Tests mock the pipeline via `vi.mock` so the
 * stub's `run()` body never executes in CI; production callers
 * that hit this stub before Slice A lands will see a clear error.
 *
 * `computeInputsSha` is a real implementation here (deterministic
 * hash over the repo file tree + input fields) so the SHA gate is
 * exercisable in tests without needing Slice A. Slice A may keep
 * or replace this implementation — the signature is what's locked.
 */

/**
 * Input contract for the code-dossier pipeline. Mirrors what
 * `ingest_repo` (mode='dossier') passes down.
 */
export interface CodeDossierInput {
  /** Absolute path to a local directory containing the repo to dossier. */
  repoPath: string;
  /**
   * Prefix used to derive memory source_ids. Memories the pipeline
   * emits use `${sourceIdPrefix}:brief`, `${sourceIdPrefix}:decision:N`,
   * etc. — chosen so a re-run with the same prefix updates instead of
   * duplicates via the engram dedupe key.
   */
  sourceIdPrefix: string;
  /** Project slug. Stamped on every emitted memory's metadata. */
  project: string;
  /** Caller-supplied tags. Pipeline appends its own (`type:brief`, …). */
  tags: readonly string[];
  /** Optional source URL — e.g. the github.com clone URL for repo. */
  sourceUrl?: string;
}

/**
 * Compute a deterministic SHA over the dossier inputs. Used by the
 * SHA-gated re-derivation path in `ingest_repo` to short-circuit
 * a re-ingest when nothing about the repo (or the caller's framing)
 * has changed.
 *
 * Hashes:
 *   - The full sorted file list under `repoPath`
 *   - Each file's size (catches edits without reading bytes)
 *   - The input's `project`, `tags`, `sourceUrl`
 *
 * Skipped: file contents themselves. That would make the hash
 * deterministic on byte-exact identity but blows the budget on
 * large repos. Size + path is a cheap proxy that catches the
 * cases the SHA gate is meant to skip ("nothing changed since
 * the last run") without scanning gigabytes.
 *
 * Slice A may replace this with a tree-hash that incorporates
 * git object SHAs when the working tree is a git clone — that
 * would be strictly better but requires more setup. The signature
 * stays the same either way.
 */
export async function computeInputsSha(input: CodeDossierInput): Promise<string> {
  const hash = createHash("sha256");
  hash.update("v1\n");
  hash.update(`project:${input.project}\n`);
  hash.update(`sourceUrl:${input.sourceUrl ?? ""}\n`);
  hash.update(`tags:${[...input.tags].sort().join(",")}\n`);

  // Stable file-tree walk. Ignored dirs match what ingest_repo's
  // full-walk uses, so the SHA reflects what the pipeline would
  // actually see.
  const IGNORE = new Set<string>([
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
    "target",
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

  const entries: Array<{ rel: string; size: number }> = [];
  const visit = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    names.sort();
    for (const name of names) {
      if (IGNORE.has(name)) continue;
      const abs = path.join(dir, name);
      let info;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await visit(abs);
      } else if (info.isFile()) {
        entries.push({
          rel: path.relative(input.repoPath, abs),
          size: info.size,
        });
      }
    }
  };
  await visit(input.repoPath);
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const { rel, size } of entries) {
    hash.update(`${rel}|${size}\n`);
  }

  return hash.digest("hex");
}

/**
 * The code-dossier pipeline. Slice A will replace the run() body
 * with the real 3-pass implementation; this stub exists so
 * Slice B's wiring (ingest_repo mode='dossier') type-checks and so
 * tests can mock the import.
 */
export const codeDossierPipeline: Pipeline<CodeDossierInput, PipelineMemory> = {
  id: "@onenomad/przm-cortex-pipeline-code-dossier",
  version: "0.1.0-stub",

  async run(input: CodeDossierInput, ctx: PipelineContext): Promise<PipelineMemory[]> {
    // Stub body — Slice A owns the real 3-pass extraction. Throws
    // loudly so a production caller that hits this before Slice A
    // ships sees a clear error rather than silently storing nothing.
    // Tests mock this via vi.mock so they don't trigger the throw.
    // Touch ctx + input so unused-arg lint stays quiet.
    void ctx;
    // Use readFile to keep the import live for Slice A's eventual
    // implementation (otherwise the unused-import lint trips).
    void readFile;
    throw new Error(
      `codeDossierPipeline.run() is a stub (input.repoPath=${input.repoPath}). ` +
        `Slice A (pipeline-code-dossier 3-pass LLM extraction) replaces this ` +
        `body with the real implementation. Until then, dossier-mode ingests ` +
        `cannot run in production — use mode='full' on ingest_repo.`,
    );
  },
};
