import type { HealthStatus } from "@onenomad/przm-cortex-core";

/**
 * Minimal logger contract, mirroring `@onenomad/przm-cortex-core`'s Logger. Imported
 * structurally so the backend stays usable in tests without the full server
 * logger plumbing.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child?(bindings: Record<string, unknown>): Logger;
}

export interface MemoryIngestInput {
  content: string;
  /**
   * Optional composed text to embed instead of `content`. When present,
   * the embedding vector is computed from this string while `content` is
   * stored as-is. Use this to include LLM-extracted enrichment (summary,
   * keywords) in the vector without altering the stored text.
   *
   * Defaults to `content` when omitted — existing behaviour is preserved.
   * See ADR-020.
   */
  embedText?: string;
  metadata: Record<string, unknown>;
}

/** Ordered sensitivity levels. Earlier = less sensitive. */
export const SENSITIVITY_LEVELS = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;

export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

/** Ordered trust levels. Earlier = less trusted. */
export const TRUST_LEVELS = ["external", "experimental", "approved"] as const;

export type TrustLevel = (typeof TRUST_LEVELS)[number];

export interface MemorySearchArgs {
  query: string;
  limit?: number;
  project?: string;
  type?: string;
  source?: string;
  /** ISO 8601 lower bound filter against `metadata.date`. */
  sinceIso?: string;
  /** Engram-compatible; filters against `memories.domain`. */
  domain?: string;
  /**
   * Workspace filter. When set, results are scoped to memories stamped
   * with this workspace OR rows with no workspace (legacy, pre-session-
   * scoping ingests). Omit to disable workspace scoping.
   */
  workspace?: string;
  /**
   * Maximum sensitivity level to include. Rows whose `metadata.sensitivity`
   * is more sensitive than this level are excluded. Omit (default) to apply
   * no filter — existing behavior is preserved.
   *
   * Ordering: public < internal < confidential < restricted.
   */
  maxSensitivity?: SensitivityLevel;
  /**
   * Minimum trust level required for results. When set, rows whose
   * `metadata.trust` is below this level are excluded (strict exclusion).
   * Omit to use soft down-ranking of `experimental` and `external` rows
   * instead (they remain in results but score lower).
   *
   * Ordering: external < experimental < approved.
   */
  minTrust?: TrustLevel;
}

export interface Memory {
  id: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  type?: string;
}

export interface MemoryDeleteArgs {
  /** Remove by source_id. Exactly one of `sourceId` / `id` required. */
  sourceId?: string;
  id?: string;
}

/**
 * Structural contract matching `EngramAccess`. Any Cortex tool that only needs
 * ingest/search/health works against this interface, so engram and
 * pgvector are interchangeable.
 */
export interface MemoryBackend {
  /** Apply schema migrations. Idempotent. Call once on boot. */
  bootstrap(): Promise<void>;

  ingest(input: MemoryIngestInput): Promise<{ id: string }>;
  /**
   * Batch ingest. Returns per-row results + errors so a caller can
   * retry just the failures. Default implementation (if any) loops
   * ingest(); backends with true batch support can override.
   */
  ingestMany(inputs: MemoryIngestInput[]): Promise<{
    results: { id: string }[];
    errors: { index: number; error: string }[];
  }>;
  search(args: MemorySearchArgs): Promise<Memory[]>;
  /**
   * Remove by stable source_id or id. Returns the number of rows
   * deleted; 0 means the row wasn't there (idempotent for callers).
   */
  delete(args: MemoryDeleteArgs): Promise<{ deleted: number }>;
  healthCheck(): Promise<HealthStatus>;
  shutdown(): Promise<void>;
  /**
   * Optional — embedded backends (PGlite) expose a native dump that
   * returns the entire data directory as a gzipped tar Blob. External
   * Postgres deployments omit this; pyre-web's cold-storage orchestrator
   * checks for presence before invoking.
   */
  dumpDataDir?(): Promise<Blob>;
  /**
   * Drop every row from the memories table. Indexes are preserved
   * (the next ingest re-fills them). Workspace config, projects,
   * people, secrets are untouched — this is data-only.
   */
  wipeAll(): Promise<{ deleted: number }>;
  /**
   * Stream every memory row in id order. Async iterator so callers
   * (typically a data-export endpoint streaming JSONL) don't have to
   * materialize the full table in memory. Each row carries id, content,
   * metadata, createdAt; the optional `includeEmbedding` flag includes
   * the vector — useful for full backups, off by default since the
   * float arrays inflate the export 10-100x.
   */
  exportAll(opts?: {
    includeEmbedding?: boolean;
    batchSize?: number;
  }): AsyncIterable<MemoryExportRow>;
}

export interface MemoryExportRow {
  id: string;
  sourceId?: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Signature the backend calls to turn content or queries into vectors. Kept
 * as an injected callback so this package has no hard dependency on the LLM
 * provider layer — any callable (Ollama, OpenAI, a fake, a cached fn) works.
 */
export type EmbedFn = (text: string) => Promise<number[]>;
