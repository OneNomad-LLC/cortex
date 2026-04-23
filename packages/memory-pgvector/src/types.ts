import type { HealthStatus } from "@onenomad/cortex-core";

/**
 * Minimal logger contract, mirroring `@onenomad/cortex-core`'s Logger. Imported
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
  metadata: Record<string, unknown>;
}

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
}

export interface Memory {
  id: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  type?: string;
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
  search(args: MemorySearchArgs): Promise<Memory[]>;
  healthCheck(): Promise<HealthStatus>;
  shutdown(): Promise<void>;
}

/**
 * Signature the backend calls to turn content or queries into vectors. Kept
 * as an injected callback so this package has no hard dependency on the LLM
 * provider layer — any callable (Ollama, OpenAI, a fake, a cached fn) works.
 */
export type EmbedFn = (text: string) => Promise<number[]>;
