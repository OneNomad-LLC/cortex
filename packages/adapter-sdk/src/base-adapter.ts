import type { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterContext,
  ClassificationContext,
  ClassifiedItem,
  HealthStatus,
  NormalizedItem,
  RawSourceItem,
  SourceAdapter,
  StreamContext,
  WebhookContext,
  WebhookHandler,
} from "@onenomad/przm-cortex-core";
import { LLMClassifier } from "./classifier-llm.js";

/**
 * Optional base class. Adapters MAY extend this for lifecycle scaffolding,
 * or implement `SourceAdapter` directly.
 */
export abstract class BaseAdapter implements SourceAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly version: string;
  abstract readonly configSchema: z.ZodTypeAny;
  abstract readonly requiredSecrets: readonly string[];
  abstract readonly capabilities: AdapterCapabilities;
  abstract readonly pipelines: readonly string[];

  protected ctx!: AdapterContext;
  protected lastSuccessAt: number | undefined;

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    await this.onInit();
  }

  /** Hook for subclass-specific init. */
  protected async onInit(): Promise<void> {
    // no-op by default
  }

  async shutdown(): Promise<void> {
    await this.onShutdown();
  }

  protected async onShutdown(): Promise<void> {
    // no-op by default
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
      };
    }
  }

  protected async probeHealth(): Promise<Record<string, unknown> | undefined> {
    // Default: assume healthy. Override for real API probes.
    return undefined;
  }

  abstract fetch(since?: Date): AsyncIterable<RawSourceItem>;
  abstract transform(raw: RawSourceItem): Promise<NormalizedItem>;
  abstract classify(
    item: NormalizedItem,
    cctx: ClassificationContext,
  ): Promise<ClassifiedItem>;

  /**
   * Optional. Subclasses override when they support real-time streaming
   * (Obsidian file-watcher, Slack events WebSocket, etc.). Declared here
   * so concrete adapters can use the `override` keyword under our strict
   * TS settings.
   */
  stream?(ctx: StreamContext): AsyncIterable<RawSourceItem>;

  /**
   * Optional. Subclasses override when the source supports webhook
   * delivery (GitHub, Slack Events HTTP, Linear, etc.).
   */
  webhook?(ctx: WebhookContext): WebhookHandler | WebhookHandler[];

  protected markSuccess(): void {
    this.lastSuccessAt = Date.now();
  }

  /**
   * Fallback classification path for adapters whose rule didn't match.
   *
   * Resolution order:
   *   1. LLM classifier — scored against the project taxonomy. When the
   *      model returns a high-confidence slug, that wins.
   *   2. `defaultProject` if the adapter config provides one — weak
   *      signal ("inbox" style).
   *   3. Unclassified — `{projects: [], confidence: 0}`. These items
   *      land in a review queue rather than a silent miss.
   *
   * Adapters call this at the end of their own classify() when no rule
   * matched.
   */
  protected async fallbackClassify(
    item: NormalizedItem,
    cctx: ClassificationContext,
    defaultProject: string,
  ): Promise<
    Pick<ClassifiedItem, "projects" | "confidence" | "classificationMethod">
  > {
    const taxonomy = this.ctx?.taxonomy;
    const llm = this.ctx?.llm;
    if (taxonomy && llm && taxonomy.listProjects({ activeOnly: true }).length > 0) {
      const classifier = new LLMClassifier({ taxonomy, llm });
      const result = await classifier.classify(item, cctx);
      if (result.projects.length > 0) return result;
    }

    if (defaultProject) {
      return {
        projects: [defaultProject],
        confidence: 0.5,
        classificationMethod: "rule",
      };
    }

    return {
      projects: [],
      confidence: 0,
      classificationMethod: "rule",
    };
  }
}
