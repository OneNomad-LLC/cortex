import type { z } from "zod";
import type { HealthStatus } from "@onenomad/cortex-core";
import type {
  EmbedRequest,
  EmbedResponse,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from "@onenomad/cortex-llm-core";

/**
 * Abstract base for all providers. Concrete providers implement `complete()`
 * (and optionally `listModels()`, `probeHealth()`).
 */
export abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly version: string;
  abstract readonly configSchema: z.ZodTypeAny;
  abstract readonly requiredSecrets: readonly string[];

  protected lastSuccessAt: number | undefined;

  async init(): Promise<void> {
    // Override if needed.
  }

  async shutdown(): Promise<void> {
    // Override if needed.
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const details = await this.probeHealth();
      return {
        healthy: true,
        message: "",
        ...(this.lastSuccessAt !== undefined
          ? { lastSuccessAt: this.lastSuccessAt }
          : {}),
        ...(details ? { details } : {}),
      };
    } catch (err) {
      return {
        healthy: false,
        message: err instanceof Error ? err.message : String(err),
        ...(this.lastSuccessAt !== undefined
          ? { lastSuccessAt: this.lastSuccessAt }
          : {}),
      };
    }
  }

  /**
   * Providers implement this with a cheap probe (list models, ping, etc.).
   * The default implementation throws so misconfigured providers fail loudly.
   */
  protected async probeHealth(): Promise<Record<string, unknown> | undefined> {
    throw new Error(
      `${this.id}: probeHealth() not implemented. Override in subclass.`,
    );
  }

  abstract complete(req: LLMRequest): Promise<LLMResponse>;

  listModels?(): Promise<string[]>;

  /**
   * Optional embeddings. Concrete providers override with `override async
   * embed(...)`. Declared here so subclasses can use the `override` keyword
   * with our strict TS settings; the default base implementation is absent.
   */
  embed?(req: EmbedRequest): Promise<EmbedResponse>;

  /** Mark a successful call for health reporting. Providers call after complete(). */
  protected markSuccess(): void {
    this.lastSuccessAt = Date.now();
  }
}
