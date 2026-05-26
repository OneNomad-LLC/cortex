import type { z } from "zod";
import type { HealthStatus } from "@onenomad/przm-cortex-core";
import type {
  EmbedRequest,
  EmbedResponse,
  LLMRequest,
  LLMResponse,
} from "./types.js";

/**
 * Every LLM provider package exports a factory that produces this. The
 * server's provider registry validates config, calls the factory, and
 * wires the result into the router.
 */
export interface LLMProvider {
  /** Stable id, matches the yaml key under `llm.providers`. */
  readonly id: string;
  readonly name: string;
  readonly version: string;

  /** Zod schema validating the provider's config block. */
  readonly configSchema: z.ZodTypeAny;
  /** Env var names the provider needs. Registry verifies at startup. */
  readonly requiredSecrets: readonly string[];

  /** Called once after construction. Open clients, warm caches, etc. */
  init(): Promise<void>;
  /** Liveness probe (should be cheap; no billable calls if avoidable). */
  healthCheck(): Promise<HealthStatus>;
  shutdown(): Promise<void>;

  /**
   * One-shot completion. The router handles retries and fallbacks around
   * this call; providers should surface typed `LLMError`s rather than
   * retrying internally.
   */
  complete(req: LLMRequest): Promise<LLMResponse>;

  /**
   * Optional: declare which models this provider can serve. If present,
   * the router validates requested models against this list at startup
   * and can reject misconfigured tasks early.
   */
  listModels?(): Promise<string[]>;

  /**
   * Optional: produce an embedding for a single string. Providers that
   * don't expose embeddings (most cloud chat aggregators) simply omit this
   * and the router will skip them when resolving `embed` tasks.
   */
  embed?(req: EmbedRequest): Promise<EmbedResponse>;
}

/**
 * Provider packages export one of these. The registry passes validated
 * config and resolved secrets.
 */
export type LLMProviderFactory = (args: {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}) => LLMProvider;
