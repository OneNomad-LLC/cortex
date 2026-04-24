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
 * Defined fully in `@onenomad/cortex-llm-core`. We keep a minimal type here to avoid
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
  healthCheck(): Promise<HealthStatus>;
}

export interface EngramIngestInput {
  content: string;
  metadata: Record<string, unknown>;
}

/**
 * Dependency bundle injected into every adapter at `init()`. Adapters never
 * reach for globals — everything external comes through this object.
 */
export interface AdapterContext {
  logger: Logger;
  taxonomy: TaxonomyReader;
  llm: LLMAccess;
  engram: EngramAccess;
  /** Adapter-scoped config, already validated against the adapter's schema. */
  config: Record<string, unknown>;
  /** Env var bag, filtered to the secrets this adapter declared it needs. */
  secrets: Record<string, string>;
  /** Parent abort signal; cancels all adapter work on shutdown. */
  signal: AbortSignal;
}
