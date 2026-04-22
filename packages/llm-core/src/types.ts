/**
 * Declarative labels pipelines use to request an LLM. The router maps these
 * to a concrete provider+model via `config/cortex.yaml > llm.tasks`.
 *
 * Keep this set small and stable. Adding a new purpose means thinking about
 * which model it routes to by default.
 */
export type TaskPurpose =
  | "default"
  | "structural" // Pass 1: extract structure from raw content
  | "synthesis" // Pass 2: quality-critical reasoning / merging context
  | "brief" // Pass 3: generate human-facing summary
  | "classify" // Project/topic inference
  | "embed"; // Reserved for future embedding use

export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMRequest {
  /** Messages in chronological order. First may be a system message. */
  messages: LLMMessage[];
  /** Model id as understood by the target provider. */
  model: string;
  /** 0-1. Provider-specific mapping if needed. */
  temperature?: number;
  maxTokens?: number;
  /** Optional JSON schema for structured output. Provider may ignore. */
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface LLMTokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface LLMResponse {
  /** Full assistant message content. Streaming not in the v1 contract. */
  content: string;
  /** Id for the model that actually served the response (post-fallback). */
  model: string;
  /** Which provider served it. */
  provider: string;
  /** Token usage if the provider reports it. */
  usage?: LLMTokenUsage;
  /** Latency in ms from request to full response. */
  latencyMs: number;
  /** Free-form details for logging (finish reason, etc.). */
  details?: Record<string, unknown>;
}

/**
 * One-shot embedding request. Batches intentionally deferred — the current
 * call site (pgvector ingest + search) embeds one item at a time, and
 * batching the ingest path is a latency optimization we can add without
 * changing the contract.
 */
export interface EmbedRequest {
  /** Text to embed. */
  input: string;
  /** Model id understood by the target provider. */
  model: string;
  /** Abort signal. */
  signal?: AbortSignal;
}

export interface EmbedResponse {
  /** The vector itself. Length must match the model's declared dimension. */
  vector: number[];
  /** Convenience accessor — `vector.length`. */
  dim: number;
  /** Model id the provider served. */
  model: string;
  /** Which provider served the call. */
  provider: string;
  /** Latency in ms. */
  latencyMs: number;
}

/**
 * Typed error raised by providers and router. Carries enough info to route
 * retries and fallbacks intelligently.
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "unreachable"
      | "rate_limited"
      | "auth"
      | "invalid_request"
      | "model_not_found"
      | "provider_error"
      | "timeout"
      | "aborted",
    public readonly provider: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMError";
  }

  /** True when the failure might succeed on a different provider. */
  get isRetryable(): boolean {
    return (
      this.kind === "unreachable" ||
      this.kind === "rate_limited" ||
      this.kind === "timeout" ||
      this.kind === "provider_error"
    );
  }
}
