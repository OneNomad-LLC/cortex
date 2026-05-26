import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMError } from "@onenomad/przm-cortex-llm-core";
import {
  OpenRouterProvider,
  openrouterConfigSchema,
} from "../src/provider.js";

const cfg = openrouterConfigSchema.parse({});

describe("OpenRouterProvider", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("requires an API key", () => {
    expect(() => new OpenRouterProvider(cfg, "")).toThrow(
      /OPENROUTER_API_KEY is required/,
    );
  });

  it("POSTs chat/completions with bearer auth and referer/title headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "anthropic/claude-haiku-4.5",
          choices: [
            {
              message: { role: "assistant", content: "hi back" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = new OpenRouterProvider(cfg, "test-key");
    const res = await provider.complete({
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      maxTokens: 64,
    });

    expect(res.content).toBe("hi back");
    expect(res.provider).toBe("openrouter");
    expect(res.usage).toEqual({ prompt: 5, completion: 2, total: 7 });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["http-referer"]).toBeDefined();
    expect(headers["x-title"]).toBe("Cortex");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBe(false);
  });

  it("maps 401 to LLMError.auth", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad key", { status: 401 }),
    );
    const provider = new OpenRouterProvider(cfg, "test-key");
    await expect(
      provider.complete({
        model: "x/y",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toSatisfy((e) => e instanceof LLMError && e.kind === "auth");
  });

  it("maps 429 to LLMError.rate_limited (retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("slow down", { status: 429 }),
    );
    const provider = new OpenRouterProvider(cfg, "test-key");
    try {
      await provider.complete({
        model: "x/y",
        messages: [{ role: "user", content: "hi" }],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).kind).toBe("rate_limited");
      expect((err as LLMError).isRetryable).toBe(true);
    }
  });
});
