import type { Person } from "./person.js";
import type { Project } from "./project.js";
import type { HealthStatus } from "./types.js";

/**
 * Minimal logger contract. Concrete implementations live in the server
 * package. Adapters receive this via AdapterContext.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Projects and people are loaded from YAML and exposed to adapters through
 * the context. Adapters should never read the config files directly.
 */
export interface TaxonomyReader {
  listProjects(opts?: { activeOnly?: boolean }): Project[];
  findProjectBySlug(slug: string): Project | undefined;
  /**
   * Match against slug or any alias. Returns the best match, preferring an
   * exact slug hit over alias matches.
   */
  findProject(query: string): Project | undefined;

  listPeople(): Person[];
  findPersonBySlug(slug: string): Person | undefined;
  findPersonByEmail(email: string): Person | undefined;
  /** Match by name or alias (case-insensitive, punctuation-insensitive). */
  findPerson(query: string): Person | undefined;
  /**
   * Returns the person flagged `self: true`, or undefined when the
   * user hasn't identified themselves yet. Callers that need "the
   * user" should go through this, not hard-code a slug.
   */
  findSelf(): Person | undefined;
}

/**
 * Forward-declared LLM client surface used by adapters and pipelines.
 * Defined fully in `@onenomad/przm-cortex-llm-core`. We keep a minimal type here to avoid
 * a circular dep; the server wires the concrete router into this slot.
 */
export interface LLMAccess {
  /** Low-level escape hatch. Prefer `complete()`. */
  raw: unknown;
  /**
   * Simple completion call routed by task purpose. Returns the assistant
   * message as a string. Pipelines use this 90% of the time.
   */
  complete(args: {
    /** Declarative purpose; the router maps this to a provider+model. */
    task: string;
    prompt: string;
    system?: string;
    /** Max tokens to generate. Provider-enforced. */
    maxTokens?: number;
    /** Sampling temperature. 0-1. */
    temperature?: number;
    /** Abort signal for cancellation. */
    signal?: AbortSignal;
  }): Promise<string>;
}

/**
 * Typed client surface for Engram MCP. Defined fully in the server package.
 * Adapters see only the methods they need.
 */
export interface EngramAccess {
  ingest(input: EngramIngestInput): Promise<{ id: string }>;
  /**
   * Remove a memory by its stable source_id (the same key ingest
   * dedupes on). Returns the number of rows removed — 0 if the id
   * was never ingested, which callers should treat as success.
   * Optional so test doubles and historical clients can omit it.
   */
  delete?(input: EngramDeleteInput): Promise<{ deleted: number }>;
  healthCheck(): Promise<HealthStatus>;
}

export interface EngramIngestInput {
  content: string;
  metadata: Record<string, unknown>;
}

export interface EngramDeleteInput {
  /** Remove by stable source_id. Exactly one of `sourceId` / `id` required. */
  sourceId?: string;
  /** Remove by backend-assigned uuid. */
  id?: string;
}

/**
 * Dependency bundle injected into every adapter at `init()`. Adapters never
 * reach for globals — everything external comes through this object.
 *
 * Cortex 0.2 — `llm` is now optional. Adapters that need LLM-backed
 * classification or summarization must check for its presence and
 * fall back to rule-based behavior (or skip enrichment) when it's
 * absent. The connected MCP client can also satisfy enrichment
 * needs via the Cortex Enrichment Protocol; pipelines route those
 * through the runtime's `EnrichmentClient` rather than `ctx.llm`.
 */
export interface AdapterContext {
  logger: Logger;
  taxonomy: TaxonomyReader;
  /** Optional — undefined when Cortex is running without a local LLM. */
  llm?: LLMAccess;
  engram: EngramAccess;
  /** Adapter-scoped config, already validated against the adapter's schema. */
  config: Record<string, unknown>;
  /** Env var bag, filtered to the secrets this adapter declared it needs. */
  secrets: Record<string, string>;
  /** Parent abort signal; cancels all adapter work on shutdown. */
  signal: AbortSignal;
}
