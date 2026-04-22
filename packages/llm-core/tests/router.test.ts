import { describe, expect, it, vi } from "vitest";
import { LLMError } from "../src/types.js";
import { LLMRouter } from "../src/router.js";
import type { LLMProvider } from "../src/provider.js";

function makeProvider(
  id: string,
  impl: (model: string) => Promise<string> | string,
  opts: {
    embed?: (input: string, model: string) => Promise<number[]> | number[];
  } = {},
): LLMProvider {
  const base: LLMProvider = {
    id,
    name: id,
    version: "0.0.0",
    configSchema: { parse: (x: unknown) => x } as never,
    requiredSecrets: [],
    init: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    shutdown: vi.fn(async () => undefined),
    complete: vi.fn(async (req) => {
      const content = await impl(req.model);
      return {
        content,
        model: req.model,
        provider: id,
        latencyMs: 1,
      };
    }),
  };
  if (opts.embed) {
    base.embed = vi.fn(async (req) => {
      const vec = await opts.embed!(req.input, req.model);
      return {
        vector: vec,
        dim: vec.length,
        model: req.model,
        provider: id,
        latencyMs: 1,
      };
    });
  }
  return base;
}

describe("LLMRouter", () => {
  it("routes tasks to their configured provider", async () => {
    const ollama = makeProvider("ollama", () => "from-ollama");
    const router = new LLMRouter({
      providers: { ollama },
      tasks: {
        default: { provider: "ollama", model: "qwen3:14b" },
        structural: { provider: "ollama", model: "qwen3:14b" },
      },
      fallbackChain: [],
    });

    const res = await router.complete({
      task: "structural",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.content).toBe("from-ollama");
    expect(res.provider).toBe("ollama");
  });

  it("falls back to the next provider on retryable error", async () => {
    const ollama = makeProvider("ollama", () => {
      throw new LLMError("down", "unreachable", "ollama");
    });
    const openrouter = makeProvider("openrouter", () => "from-openrouter");
    const router = new LLMRouter({
      providers: { ollama, openrouter },
      tasks: {
        default: { provider: "ollama", model: "qwen3:14b" },
        synthesis: {
          provider: "openrouter",
          model: "anthropic/claude-haiku-4.5",
        },
      },
      fallbackChain: ["openrouter"],
    });

    const res = await router.complete({
      task: "default",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.provider).toBe("openrouter");
    // Fallback should pick the openrouter task binding's model.
    expect(res.model).toBe("anthropic/claude-haiku-4.5");
  });

  it("rethrows non-retryable errors immediately without fallback", async () => {
    const ollama = makeProvider("ollama", () => {
      throw new LLMError("bad key", "auth", "ollama");
    });
    const openrouter = makeProvider("openrouter", () => "never");
    const openrouterSpy = openrouter.complete as ReturnType<typeof vi.fn>;
    const router = new LLMRouter({
      providers: { ollama, openrouter },
      tasks: {
        default: { provider: "ollama", model: "qwen3:14b" },
      },
      fallbackChain: ["openrouter"],
    });

    await expect(
      router.complete({
        task: "default",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toSatisfy((e) => e instanceof LLMError && e.kind === "auth");
    expect(openrouterSpy).not.toHaveBeenCalled();
  });

  it("routes embed() to the configured embed task provider", async () => {
    const ollama = makeProvider("ollama", () => "x", {
      embed: () => [0.1, 0.2, 0.3, 0.4],
    });
    const router = new LLMRouter({
      providers: { ollama },
      tasks: {
        default: { provider: "ollama", model: "qwen3:14b" },
        embed: { provider: "ollama", model: "nomic-embed-text" },
      },
      fallbackChain: [],
    });
    const res = await router.embed({ task: "embed", input: "hello" });
    expect(res.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(res.provider).toBe("ollama");
    expect(res.model).toBe("nomic-embed-text");
  });

  it("embed() skips providers without an embed() method when walking fallback", async () => {
    // Openrouter has no embed(). Primary fails unreachable. Router should
    // walk the chain, see that the next provider lacks embed, skip it, and
    // surface the original error.
    const ollama = makeProvider("ollama", () => "x", {
      embed: () => {
        throw new LLMError("down", "unreachable", "ollama");
      },
    });
    const openrouter = makeProvider("openrouter", () => "x");
    const router = new LLMRouter({
      providers: { ollama, openrouter },
      tasks: {
        default: { provider: "ollama", model: "qwen3:14b" },
        embed: { provider: "ollama", model: "nomic-embed-text" },
      },
      fallbackChain: ["openrouter"],
    });
    await expect(
      router.embed({ task: "embed", input: "hi" }),
    ).rejects.toSatisfy((e) => e instanceof LLMError && e.kind === "unreachable");
  });

  it("embed() falls back to a provider that does implement embed()", async () => {
    const ollama = makeProvider("ollama", () => "x", {
      embed: () => {
        throw new LLMError("down", "unreachable", "ollama");
      },
    });
    const alt = makeProvider("alt", () => "x", {
      embed: () => [9, 9, 9],
    });
    const router = new LLMRouter({
      providers: { ollama, alt },
      tasks: {
        default: { provider: "ollama", model: "qwen3:14b" },
        embed: { provider: "ollama", model: "nomic-embed-text" },
      },
      // Include an `alt` task binding so pickFallbackModel finds a model
      // for this provider when it walks the chain.
      fallbackChain: ["alt"],
    });
    // The router needs a known model for `alt` — we route via pickFallback
    // which prefers any task bound to the fallback provider. Add one by
    // re-instantiating with an alt binding:
    const router2 = new LLMRouter({
      providers: { ollama, alt },
      tasks: {
        default: { provider: "ollama", model: "qwen3:14b" },
        embed: { provider: "ollama", model: "nomic-embed-text" },
        altEmbed: { provider: "alt", model: "alt-embed-1" },
      },
      fallbackChain: ["alt"],
    });
    void router; // silence unused
    const res = await router2.embed({ task: "embed", input: "hi" });
    expect(res.provider).toBe("alt");
    expect(res.vector).toEqual([9, 9, 9]);
  });

  it("embed() treats a provider without embed() as a fallthrough, not a hard error", async () => {
    const openrouter = makeProvider("openrouter", () => "x"); // no embed
    const router = new LLMRouter({
      providers: { openrouter },
      tasks: {
        default: { provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
        embed: {
          provider: "openrouter",
          model: "anthropic/claude-haiku-4.5",
        },
      },
      fallbackChain: [],
    });
    await expect(
      router.embed({ task: "embed", input: "hi" }),
    ).rejects.toMatchObject({
      name: "LLMError",
      kind: "invalid_request",
    });
  });

  it("rejects config that references an unknown provider", () => {
    const ollama = makeProvider("ollama", () => "x");
    expect(
      () =>
        new LLMRouter({
          providers: { ollama },
          tasks: {
            default: { provider: "ollama", model: "qwen3:14b" },
            structural: { provider: "missing", model: "x" },
          },
          fallbackChain: [],
        }),
    ).toThrow(/unknown provider 'missing'/);
  });
});
