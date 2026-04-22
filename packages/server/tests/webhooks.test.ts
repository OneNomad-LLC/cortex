import { describe, expect, it, vi } from "vitest";
import type { Logger, SourceAdapter, WebhookHandler } from "@cortex/core";
import { createWebhookReceiver } from "../src/webhooks.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

// Bare-bones fake adapter that declares one webhook route.
function makeAdapter(handler: WebhookHandler): SourceAdapter {
  return {
    id: "fake",
    name: "Fake",
    version: "0.0.0",
    configSchema: { parse: (x: unknown) => x } as never,
    requiredSecrets: [],
    capabilities: {
      supportsIncrementalSync: true,
      supportsWebhooks: true,
      supportsAttachments: false,
      supportsComments: false,
      supportsRealTime: false,
    },
    pipelines: [],
    init: async () => {},
    healthCheck: async () => ({ healthy: true, message: "" }),
    shutdown: async () => {},
    async *fetch() {},
    transform: async () => ({
      sourceId: "fake:1",
      sourceType: "obsidian",
      sourceUrl: "",
      title: "",
      content: "",
      contentType: "note",
      createdAt: new Date(),
      updatedAt: new Date(),
      authors: [],
      rawMetadata: {},
    }),
    classify: async (i) => ({
      ...i,
      projects: [],
      confidence: 0,
      classificationMethod: "rule",
    }),
    webhook: () => handler,
  };
}

const stubEngram = {
  ingest: vi.fn(async () => ({ id: "mem-1" })),
  search: async () => [],
  healthCheck: async () => ({ healthy: true, message: "" }),
  shutdown: async () => {},
};

async function post(url: string, body: string, headers: Record<string, string>) {
  return fetch(url, { method: "POST", body, headers });
}

describe("createWebhookReceiver", () => {
  it("responds 404 for unknown paths", async () => {
    const adapter = makeAdapter({
      path: "/hooks/fake",
      verify: async () => ({ ok: true }),
      parse: async () => [],
    });
    const receiver = createWebhookReceiver({
      adapters: [adapter],
      engram: stubEngram,
      logger: silentLogger,
      port: 0,
    });
    await receiver.start();
    try {
      const port = receiver.boundPort();
      const res = await post(`http://127.0.0.1:${port}/nope`, "{}", {});
      expect(res.status).toBe(404);
    } finally {
      await receiver.stop();
    }
  });

  it("rejects with 401 when verify() fails", async () => {
    const adapter = makeAdapter({
      path: "/hooks/fake",
      verify: async () => ({ ok: false, reason: "no sig" }),
      parse: async () => [],
    });
    const receiver = createWebhookReceiver({
      adapters: [adapter],
      engram: stubEngram,
      logger: silentLogger,
      port: 0,
    });
    await receiver.start();
    try {
      const port = receiver.boundPort();
      const res = await post(`http://127.0.0.1:${port}/hooks/fake`, "{}", {});
      expect(res.status).toBe(401);
    } finally {
      await receiver.stop();
    }
  });

  it("runs items through processItem after a 204 response", async () => {
    const adapter = makeAdapter({
      path: "/hooks/fake",
      verify: async () => ({ ok: true }),
      parse: async () => [{ sourceId: "fake:7", raw: { hi: true } }],
    });
    const engramSpy = { ...stubEngram, ingest: vi.fn(async () => ({ id: "m" })) };
    // Transform/classify run through, pipelines list is empty, so ingest
    // is never called. We're verifying the response is 204 and the
    // pipeline doesn't block the response.
    const receiver = createWebhookReceiver({
      adapters: [adapter],
      engram: engramSpy,
      logger: silentLogger,
      port: 0,
    });
    await receiver.start();
    try {
      const port = receiver.boundPort();
      const res = await post(`http://127.0.0.1:${port}/hooks/fake`, "{}", {});
      expect(res.status).toBe(204);
      // Give the async post-response work a moment to run.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      await receiver.stop();
    }
  });

  it("skips adapters without webhook() silently", async () => {
    const bare: SourceAdapter = {
      ...makeAdapter({
        path: "/ignored",
        verify: async () => ({ ok: true }),
        parse: async () => [],
      }),
    };
    delete (bare as Partial<SourceAdapter>).webhook;
    const receiver = createWebhookReceiver({
      adapters: [bare],
      engram: stubEngram,
      logger: silentLogger,
      port: 0,
    });
    expect(receiver.routes()).toHaveLength(0);
  });

  it("rejects adapter handlers with malformed paths at construction time", () => {
    const adapter = makeAdapter({
      path: "no-leading-slash",
      verify: async () => ({ ok: true }),
      parse: async () => [],
    });
    expect(() =>
      createWebhookReceiver({
        adapters: [adapter],
        engram: stubEngram,
        logger: silentLogger,
        port: 0,
      }),
    ).toThrow(/must start with/);
  });
});
