/**
 * Input contract for the code dossier pipeline.
 *
 * The pipeline reads from a checked-out repo on the local filesystem.
 * Callers (the GitHub adapter, the `ingest_repo` MCP tool, ad-hoc CLI
 * runs) are responsible for getting the working tree into place first
 * (clone / pull / unpack). The pipeline itself never touches the network.
 */
export interface CodeDossierInput {
  /** Local filesystem path to a checked-out repo. */
  readonly repoPath: string;
  /**
   * Stable id prefix for `source_id` construction. The pipeline appends
   * `:dossier`, `:adr:<file>`, and `:api:<path>` to this prefix when
   * emitting individual memories.
   *
   * Typical values:
   *   - `"github:OneNomad-LLC/cortex"` for a GitHub repo
   *   - `"manual:cortex"` for an ad-hoc local-only ingest
   */
  readonly sourceIdPrefix: string;
  /** Cortex project slug to tag emitted memories with. */
  readonly project?: string;
  /** Free-form tags added to every emitted memory. */
  readonly tags?: ReadonlyArray<string>;
  /**
   * "Display" URL for the source — used as the `source_url` metadata
   * field. Falls back to a synthetic `https://repo.local/<basename>`
   * URL when omitted (the memory schema requires a parseable URL).
   */
  readonly sourceUrl?: string;
}

/**
 * Internal Pass 1 output. Pure file-system extraction, no LLM. Sized so
 * the synthesis prompt fits well under the model's context window.
 *
 * Every string field is either the file contents (potentially trimmed)
 * or an empty string when the file is absent. Callers downstream should
 * treat the empty string as "no signal" rather than "explicitly empty".
 */
export interface StructuralPayload {
  readonly repoName: string;
  readonly readme: string;
  readonly architecture: string;
  readonly claudeMd: string;
  readonly agentsMd: string;
  readonly decisions: string;
  readonly adrFiles: ReadonlyArray<AdrFile>;
  readonly roadmap: string;
  readonly migration: string;
  readonly changelog: string;
  /**
   * The detected primary manifest (package.json / pyproject.toml /
   * Cargo.toml / Gemfile / go.mod), with its filename so downstream
   * code knows which ecosystem it came from. `parsed` is set only for
   * JSON manifests.
   */
  readonly manifest: ManifestFile | null;
  /** Monorepo workspace manifest (pnpm-workspace.yaml / lerna.json / etc.). */
  readonly monorepoManifest: ManifestFile | null;
  readonly entryPoints: ReadonlyArray<EntryPointFile>;
}

export interface AdrFile {
  /** Filename only (no directory), e.g. "ADR-008.md". */
  readonly filename: string;
  /** Absolute path within the repo, e.g. "docs/ADR-008.md". */
  readonly path: string;
  readonly content: string;
}

export interface EntryPointFile {
  /** Repo-relative path, e.g. "src/index.ts" or "packages/server/src/index.ts". */
  readonly path: string;
  /**
   * File content. Capped per file by the pipeline so individual large
   * entry points don't blow the synthesis prompt budget.
   */
  readonly content: string;
}

export interface ManifestFile {
  readonly filename: string;
  readonly content: string;
  /** Set for JSON manifests; null otherwise. */
  readonly parsed: Record<string, unknown> | null;
}

/**
 * Tunable knobs. All optional; defaults are sized for a typical TS
 * monorepo and a 128k-token context model.
 */
export interface CodeDossierPipelineOptions {
  /** Hard cap on the synthesis prompt's combined source-block size, in characters. Default 200_000. */
  readonly maxStructuralPayloadChars?: number;
  /** Cap on each entry-point file's content, in characters. Default 10_000. */
  readonly maxEntryPointChars?: number;
  /** Cap on every other text file's content, in characters. Default 50_000. */
  readonly maxTextFileChars?: number;
  /** Limit on how many entry-point files we sample. Default 12. */
  readonly maxEntryPoints?: number;
  /** Limit on how many ADR files we ingest. Default 50. */
  readonly maxAdrFiles?: number;
  /** Skip Pass 3 (the polish pass) and emit the Pass 2 dossier directly. Useful for cost-sensitive runs. Default false. */
  readonly skipBriefPolish?: boolean;
}
