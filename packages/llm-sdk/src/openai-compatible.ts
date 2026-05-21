import {
  LLMError,
  type LLMRequest,
  type LLMResponse,
} from "@onenomad/przm-cortex-llm-core";
import { BaseLLMProvider } from "./base-provider.js";
import { httpFetch } from "./http.js";

/**
 * Most cloud providers expose an OpenAI-compatible `/chat/completions`
 * endpoint these days. Subclasses only set baseUrl and auth headers.
 */
export abstract class OpenAICompatibleProvider extends BaseLLMProvider {
  protected abstract baseUrl(): string;
  protected abstract authHeaders(): Record<string, string>;

  /** Override to add e.g. HTTP-Referer for OpenRouter. */
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  override async complete(req: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    const payload = {
      model: req.model,
      messages: req.messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      stream: false,
    };

    const data = await httpFetch<OpenAIChatResponse>(
      `${this.baseUrl().replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: { ...this.authHeaders(), ...this.extraHeaders() },
        body: payload,
        provider: this.id,
        ...(req.signal ? { signal: req.signal } : {}),
      },
    );

    const choice = data.choices?.[0];
    if (!choice) {
      throw new LLMError(
        `${this.id}: response had no choices`,
        "provider_error",
        this.id,
      );
    }

    this.markSuccess();

    const response: LLMResponse = {
      content: choice.message?.content ?? "",
      model: data.model ?? req.model,
      provider: this.id,
      latencyMs: Date.now() - started,
    };
    if (data.usage) {
      response.usage = {
        prompt: data.usage.prompt_tokens ?? 0,
        completion: data.usage.completion_tokens ?? 0,
        total: data.usage.total_tokens ?? 0,
      };
    }
    if (choice.finish_reason) {
      response.details = { finishReason: choice.finish_reason };
    }
    return response;
  }

  override async listModels(): Promise<string[]> {
    const data = await httpFetch<{ data: Array<{ id: string }> }>(
      `${this.baseUrl().replace(/\/$/, "")}/models`,
      {
        headers: { ...this.authHeaders(), ...this.extraHeaders() },
        provider: this.id,
      },
    );
    return data.data.map((m) => m.id);
  }

  protected override async probeHealth(): Promise<
    Record<string, unknown> | undefined
  > {
    const models = await this.listModels();
    return { modelCount: models.length };
  }
}

interface OpenAIChatResponse {
  model?: string;
  choices?: Array<{
    message?: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
