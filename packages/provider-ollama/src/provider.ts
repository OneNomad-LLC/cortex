import { z } from "zod";
import type {
  EmbedRequest,
  EmbedResponse,
  LLMProviderFactory,
  LLMRequest,
  LLMResponse,
} from "@cortex/llm-core";
import { LLMError } from "@cortex/llm-core";
import { BaseLLMProvider, httpFetch } from "@cortex/llm-sdk";

export const ollamaConfigSchema = z.object({
  host: z.string().url().default("http://localhost:11434"),
  defaultModel: z.string().default("qwen3:14b"),
  timeoutMs: z.number().int().positive().default(120_000),
  keepAlive: z.string().default("30m"),
  /**
   * Disable reasoning/thinking mode for models that support it (Qwen3,
   * Deepseek-R1, etc.). Cortex pipelines generally don't need CoT —
   * thinking tokens slow responses and burn context. Set to `true` if a
   * specific task benefits from it.
   */
  think: z.boolean().default(false),
});

export type OllamaConfig = z.infer<typeof ollamaConfigSchema>;

export class OllamaProvider extends BaseLLMProvider {
  readonly id = "ollama";
  readonly name = "Ollama";
  readonly version = "0.1.0";
  readonly configSchema = ollamaConfigSchema;
  readonly requiredSecrets = [] as const;

  constructor(private readonly cfg: OllamaConfig) {
    super();
  }

  override async complete(req: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    const { system, userPrompt } = flattenMessages(req.messages);

    const data = await httpFetch<OllamaGenerateResponse>(
      `${this.host()}/api/generate`,
      {
        method: "POST",
        body: {
          model: req.model || this.cfg.defaultModel,
          prompt: userPrompt,
          system,
          stream: false,
          keep_alive: this.cfg.keepAlive,
          // `think` is a top-level Ollama option (0.21+). Disabled by
          // default so pipeline work doesn't eat tokens on reasoning.
          think: this.cfg.think,
          options: {
            ...(req.temperature !== undefined
              ? { temperature: req.temperature }
              : {}),
            ...(req.maxTokens !== undefined
              ? { num_predict: req.maxTokens }
              : {}),
          },
        },
        provider: this.id,
        timeoutMs: this.cfg.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      },
    );

    if (typeof data.response !== "string") {
      throw new LLMError(
        `ollama: malformed response (missing 'response')`,
        "provider_error",
        this.id,
      );
    }

    this.markSuccess();

    return {
      content: stripThinking(data.response),
      model: data.model ?? req.model,
      provider: this.id,
      ...(data.prompt_eval_count !== undefined || data.eval_count !== undefined
        ? {
            usage: {
              prompt: data.prompt_eval_count ?? 0,
              completion: data.eval_count ?? 0,
              total:
                (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
            },
          }
        : {}),
      latencyMs: Date.now() - started,
      details: {
        done: data.done,
        ...(data.done_reason ? { doneReason: data.done_reason } : {}),
      },
    };
  }

  override async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const started = Date.now();
    const data = await httpFetch<OllamaEmbedResponse>(
      `${this.host()}/api/embed`,
      {
        method: "POST",
        body: {
          model: req.model || this.cfg.defaultModel,
          input: req.input,
          keep_alive: this.cfg.keepAlive,
        },
        provider: this.id,
        timeoutMs: this.cfg.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      },
    );

    // Ollama's /api/embed returns `embeddings: number[][]` even for a single
    // input — pick the first row. Older Ollama builds use `/api/embeddings`
    // with `embedding: number[]`; we don't target that endpoint any more
    // but surface a helpful error if the newer one is unavailable.
    const vector = data.embeddings?.[0];
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new LLMError(
        "ollama: /api/embed returned no embedding rows",
        "provider_error",
        this.id,
      );
    }

    this.markSuccess();

    return {
      vector,
      dim: vector.length,
      model: data.model ?? req.model,
      provider: this.id,
      latencyMs: Date.now() - started,
    };
  }

  override async listModels(): Promise<string[]> {
    const data = await httpFetch<OllamaTagsResponse>(
      `${this.host()}/api/tags`,
      {
        provider: this.id,
        timeoutMs: 10_000,
      },
    );
    return (data.models ?? []).map((m) => m.name);
  }

  protected override async probeHealth(): Promise<
    Record<string, unknown> | undefined
  > {
    const models = await this.listModels();
    return {
      host: this.host(),
      modelCount: models.length,
      hasDefault: models.includes(this.cfg.defaultModel),
    };
  }

  private host(): string {
    return this.cfg.host.replace(/\/$/, "");
  }
}

export const createOllamaProvider: LLMProviderFactory = ({ config }) => {
  const parsed = ollamaConfigSchema.parse(config);
  return new OllamaProvider(parsed);
};

/**
 * Builds a system+user pair from OpenAI-style messages. Ollama's `/api/generate`
 * accepts a single prompt, so we concatenate assistant/user turns in order.
 * For full chat history, callers should switch to `/api/chat` in a future v2.
 */
function flattenMessages(messages: LLMRequest["messages"]): {
  system: string | undefined;
  userPrompt: string;
} {
  const systemParts: string[] = [];
  const convoParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") systemParts.push(msg.content);
    else if (msg.role === "user") convoParts.push(msg.content);
    else convoParts.push(`Assistant: ${msg.content}`);
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    userPrompt: convoParts.join("\n\n"),
  };
}

/**
 * Reasoning models (Qwen3, Deepseek-R1, etc.) emit `<think>...</think>`
 * blocks in front of their visible answer. Strip them before surfacing so
 * downstream pipelines don't have to care. The raw text is still in Ollama's
 * own logs if we ever need to inspect thinking traces.
 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trimStart();
}

interface OllamaGenerateResponse {
  model?: string;
  response?: string;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

interface OllamaEmbedResponse {
  model?: string;
  embeddings?: number[][];
}
