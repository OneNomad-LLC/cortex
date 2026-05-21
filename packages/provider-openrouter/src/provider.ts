import { z } from "zod";
import type { LLMProviderFactory } from "@onenomad/przm-cortex-llm-core";
import { OpenAICompatibleProvider } from "@onenomad/przm-cortex-llm-sdk";

export const openrouterConfigSchema = z.object({
  baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
  /** Sent as HTTP-Referer; shows up in OpenRouter's activity feed. */
  referer: z.string().default("https://cortex.local"),
  /** Sent as X-Title. */
  appTitle: z.string().default("Cortex"),
});

export type OpenRouterConfig = z.infer<typeof openrouterConfigSchema>;

export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly id = "openrouter";
  readonly name = "OpenRouter";
  readonly version = "0.1.0";
  readonly configSchema = openrouterConfigSchema;
  readonly requiredSecrets = ["OPENROUTER_API_KEY"] as const;

  constructor(
    private readonly cfg: OpenRouterConfig,
    private readonly apiKey: string,
  ) {
    super();
    if (!apiKey) {
      throw new Error("OpenRouterProvider: OPENROUTER_API_KEY is required");
    }
  }

  protected override baseUrl(): string {
    return this.cfg.baseUrl;
  }

  protected override authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  protected override extraHeaders(): Record<string, string> {
    return {
      "http-referer": this.cfg.referer,
      "x-title": this.cfg.appTitle,
    };
  }
}

export const createOpenRouterProvider: LLMProviderFactory = ({
  config,
  secrets,
}) => {
  const parsed = openrouterConfigSchema.parse(config);
  const apiKey = secrets.OPENROUTER_API_KEY ?? "";
  return new OpenRouterProvider(parsed, apiKey);
};
