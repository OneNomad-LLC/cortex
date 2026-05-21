import { describe, expect, it, vi } from "vitest";
import type { Logger, SourceAdapter, StreamContext } from "@onenomad/przm-cortex-core";
import { startStreamWorkers } from "../src/streams.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const stubEngram = {
  ingest: vi.fn(async () => ({ id: "mem" })),
  search: async () => [],
  healthCheck: async () => ({ healthy: true, message: "" }),
  shutdown: async () => {},
};

function makeStreamingAdapter(
  items: Array<{ sourceId: string; raw: unknown }>,
  options: { waitForever?: boolean } = {},
): SourceAdapter {
  return {
    id: "fake-stream",
    name: "Fake Stream",
    version: "0.0.0",
    configSchema: { parse: (x: unknown) => x } as never,
    requiredSecrets: [],
    capabilities: {
      supportsIncrementalSync: true,
      supportsWebhooks: false,
      supportsAttachments: false,
      supportsComments: false,
      supportsRealTime: true,
    },
    pipelines: [],
    init: async () => {},
    healthCheck: async () => ({ healthy: true, message: "" }),
    shutdown: async () => {},
    async *fetch() {},
    transform: async (raw) => ({
      sourceId: raw.sourceId,
      sourceType: "obsidian",
      sourceUrl: "",
      title: "t",
      content: "c",
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
    async *stream(ctx: StreamContext) {
      for (const item of items) {
        if (ctx.signal.aborted) return;
        yield item;
      }
      if (options.waitForever) {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  };
}

describe("startStreamWorkers", () => {
  it("spawns one worker per adapter that implements stream()", async () => {
    const streamingAdapter = makeStreamingAdapter(
      [{ sourceId: "a", raw: {} }],
      { waitForever: true },
    );
    const cronOnlyAdapter: SourceAdapter = { ...streamingAdapter };
    delete (cronOnlyAdapter as Partial<SourceAdapter>).stream;

    const workers = startStreamWorkers({
      adapters: [streamingAdapter, cronOnlyAdapter],
      engram: stubEngram,
      logger: silentLogger,
    });
    try {
      expect(workers).toHaveLength(1);
      expect(workers[0]!.adapterId).toBe("fake-stream");
    } finally {
      await Promise.all(workers.map((w) => w.stop()));
    }
  });

  it("drains the iterator and stops cleanly when it ends", async () => {
    const adapter = makeStreamingAdapter([
      { sourceId: "x", raw: {} },
      { sourceId: "y", raw: {} },
    ]);
    const workers = startStreamWorkers({
      adapters: [adapter],
      engram: stubEngram,
      logger: silentLogger,
    });
    await workers[0]!.done;
  });

  it("stop() cancels a long-running stream via signal", async () => {
    const adapter = makeStreamingAdapter(
      [{ sourceId: "z", raw: {} }],
      { waitForever: true },
    );
    const workers = startStreamWorkers({
      adapters: [adapter],
      engram: stubEngram,
      logger: silentLogger,
    });
    // stop() must resolve even though the stream is waitForever.
    await workers[0]!.stop();
  });
});
