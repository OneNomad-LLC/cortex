import type { LLMProvider } from "./provider.js";
import {
  LLMError,
  type EmbedRequest,
  type EmbedResponse,
  type LLMRequest,
  type LLMResponse,
  type TaskPurpose,
} from "./types.js";

/**
 * Task binding resolved at startup from `config/cortex.yaml > llm.tasks`.
 */
export interface TaskBinding {
  provider: string;
  model: string;
}

export interface LLMRouterConfig {
  /** Registered providers by id. */
  providers: Record<string, LLMProvider>;
  /** Task purpose -> provider+model mapping. Must include "default". */
  tasks: Record<string, TaskBinding> & { default: TaskBinding };
  /**
   * Provider ids to try in order when the primary for a task fails with a
   * retryable error. First match wins; empty means no fallback.
   */
  fallbackChain: readonly string[];
  /** Optional logger. */
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    info: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface RouteArgs {
  task: TaskPurpose | string;
  /** Per-call overrides (debugging, experiments). */
  override?: Partial<TaskBinding>;
}

/**
 * Resolves task purposes to providers, manages a fallback chain, and
 * exposes a `complete()` that pipelines call. Built once by the server
 * and handed to adapters/pipelines via `AdapterContext.llm`.
 */
export class LLMRouter {
  constructor(private readonly cfg: LLMRouterConfig) {
    if (!cfg.tasks.default) {
      throw new Error("LLMRouter: config.tasks must include a 'default' key.");
    }
    // Warn-but-don't-crash when a task references an unknown provider.
    // This happens legitimately in two cases:
    //   1. A fresh workspace has no providers enabled yet but still
    //      ships a default task binding so cortex.yaml is schema-valid.
    //   2. User hot-disables a provider while a task still references it.
    // Both should boot and surface the mismatch at `complete()` time
    // with a clear "no usable provider" error, not crash on startup.
    for (const [task, binding] of Object.entries(cfg.tasks)) {
      if (!cfg.providers[binding.provider]) {
        cfg.logger?.warn("LLMRouter: task references unconfigured provider", {
          task,
          provider: binding.provider,
          hint:
            "enable the provider from /providers or re-bind the task via `llm.tasks` in cortex.yaml",
        });
      }
    }
  }

  /** Resolve a task to its concrete binding, applying overrides. */
  resolve(args: RouteArgs): TaskBinding {
    const bound = this.cfg.tasks[args.task] ?? this.cfg.tasks.default;
    return {
      provider: args.override?.provider ?? bound.provider,
      model: args.override?.model ?? bound.model,
    };
  }

  /**
   * Execute a completion. Tries the primary provider; on retryable failure,
   * walks the fallback chain (skipping providers already tried).
   */
  async complete(
    args: RouteArgs & Omit<LLMRequest, "model">,
  ): Promise<LLMResponse> {
    const primary = this.resolve(args);
    const tried = new Set<string>();

    const attempt = async (
      providerId: string,
      model: string,
    ): Promise<LLMResponse> => {
      tried.add(providerId);
      const provider = this.cfg.providers[providerId];
      if (!provider) {
        throw new LLMError(
          `Provider '${providerId}' not registered`,
          "provider_error",
          providerId,
        );
      }
      return provider.complete({
        messages: args.messages,
        model,
        ...(args.temperature !== undefined
          ? { temperature: args.temperature }
          : {}),
        ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
        ...(args.responseSchema
          ? { responseSchema: args.responseSchema }
          : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      });
    };

    try {
      return await attempt(primary.provider, primary.model);
    } catch (err) {
      const llmErr = toLLMError(err, primary.provider);
      if (!llmErr.isRetryable) throw llmErr;
      this.cfg.logger?.warn("llm.primary_failed", {
        task: args.task,
        provider: primary.provider,
        kind: llmErr.kind,
      });

      for (const fallbackId of this.cfg.fallbackChain) {
        if (tried.has(fallbackId)) continue;
        const fallbackProvider = this.cfg.providers[fallbackId];
        if (!fallbackProvider) continue;
        try {
          const fallbackModel = this.pickFallbackModel(fallbackId, primary);
          this.cfg.logger?.info("llm.fallback_attempt", {
            task: args.task,
            from: primary.provider,
            to: fallbackId,
            model: fallbackModel,
          });
          return await attempt(fallbackId, fallbackModel);
        } catch (fallbackErr) {
          const fErr = toLLMError(fallbackErr, fallbackId);
          if (!fErr.isRetryable) throw fErr;
          this.cfg.logger?.warn("llm.fallback_failed", {
            task: args.task,
            provider: fallbackId,
            kind: fErr.kind,
          });
        }
      }

      throw llmErr;
    }
  }

  /**
   * Execute an embedding request. Same fallback behavior as `complete()`,
   * but skips any provider that doesn't implement `embed` — they're
   * advisory-only for embedding routes, never fatal.
   */
  async embed(
    args: RouteArgs & Omit<EmbedRequest, "model">,
  ): Promise<EmbedResponse> {
    const primary = this.resolve(args);
    const tried = new Set<string>();

    const attempt = async (
      providerId: string,
      model: string,
    ): Promise<EmbedResponse> => {
      tried.add(providerId);
      const provider = this.cfg.providers[providerId];
      if (!provider) {
        throw new LLMError(
          `Provider '${providerId}' not registered`,
          "provider_error",
          providerId,
        );
      }
      if (!provider.embed) {
        throw new LLMError(
          `Provider '${providerId}' does not support embeddings`,
          "invalid_request",
          providerId,
        );
      }
      return provider.embed({
        input: args.input,
        model,
        ...(args.signal ? { signal: args.signal } : {}),
      });
    };

    try {
      return await attempt(primary.provider, primary.model);
    } catch (err) {
      const llmErr = toLLMError(err, primary.provider);
      // invalid_request on "no embed support" is structurally non-retryable,
      // but we still want to try the next provider in the chain — the point
      // of fallback for embed tasks is exactly "skip providers that can't".
      const shouldWalkChain =
        llmErr.isRetryable || llmErr.kind === "invalid_request";
      if (!shouldWalkChain) throw llmErr;
      this.cfg.logger?.warn("llm.embed.primary_failed", {
        task: args.task,
        provider: primary.provider,
        kind: llmErr.kind,
      });

      for (const fallbackId of this.cfg.fallbackChain) {
        if (tried.has(fallbackId)) continue;
        const fallbackProvider = this.cfg.providers[fallbackId];
        if (!fallbackProvider?.embed) continue;
        try {
          const fallbackModel = this.pickFallbackModel(fallbackId, primary);
          this.cfg.logger?.info("llm.embed.fallback_attempt", {
            task: args.task,
            from: primary.provider,
            to: fallbackId,
            model: fallbackModel,
          });
          return await attempt(fallbackId, fallbackModel);
        } catch (fallbackErr) {
          const fErr = toLLMError(fallbackErr, fallbackId);
          if (!fErr.isRetryable && fErr.kind !== "invalid_request") {
            throw fErr;
          }
          this.cfg.logger?.warn("llm.embed.fallback_failed", {
            task: args.task,
            provider: fallbackId,
            kind: fErr.kind,
          });
        }
      }

      throw llmErr;
    }
  }

  /**
   * Best-effort model selection when falling back. Prefers the task's own
   * binding for that provider if present, otherwise the default binding
   * for that provider, otherwise the original model string (may not work,
   * but surfacing an error is better than silently picking wrong).
   */
  private pickFallbackModel(
    providerId: string,
    primary: TaskBinding,
  ): string {
    for (const binding of Object.values(this.cfg.tasks)) {
      if (binding.provider === providerId) return binding.model;
    }
    return primary.model;
  }
}

function toLLMError(err: unknown, provider: string): LLMError {
  if (err instanceof LLMError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new LLMError(err.message, "aborted", provider, err);
  }
  return new LLMError(
    err instanceof Error ? err.message : String(err),
    "provider_error",
    provider,
    err,
  );
}
