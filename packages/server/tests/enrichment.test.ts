import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadTaxonomy } from "../src/taxonomy.js";
import { EnrichmentQueue } from "../src/enrichment.js";
import { pendingEnrichmentRequests } from "../src/mcp/tools/pending-enrichment-requests.js";
import { submitEnrichmentResult } from "../src/mcp/tools/submit-enrichment-result.js";
import type { ToolContext } from "../src/mcp/tool.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function nullLogger() {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return log;
    },
  };
  return log;
}

async function makeCtx(queue?: EnrichmentQueue): Promise<ToolContext> {
  const taxonomy = await loadTaxonomy({
    projectsPath: path.join(fixturesDir, "projects.yaml"),
    peoplePath: path.join(fixturesDir, "people.yaml"),
  });
  const logger = nullLogger();
  return {
    taxonomy,
    logger,
    engram: {
      ingest: vi.fn(async () => ({ id: "fake" })),
      search: vi.fn(async () => []),
      healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
      shutdown: vi.fn(async () => undefined),
    },
    persona: {
      cognitiveLoad: vi.fn(async () => "medium"),
      signal: vi.fn(async () => undefined),
      healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
      shutdown: vi.fn(async () => undefined),
    },
    ...(queue ? { enrichmentQueue: queue } : {}),
  };
}

describe("EnrichmentQueue", () => {
  it("resolves a pending request when submit() is called with the matching id", async () => {
    const queue = new EnrichmentQueue({ logger: nullLogger() });
    const enrichPromise = queue.enrich({
      type: "summarize",
      payload: { content: "hello world" },
    });
    expect(queue.size()).toBe(1);
    const drained = queue.drain();
    expect(drained).toHaveLength(1);
    queue.submit(drained[0]!.id, {
      summary: "hi",
      key_points: ["a", "b"],
    });
    const result = await enrichPromise;
    expect(result).toEqual({ summary: "hi", key_points: ["a", "b"] });
    expect(queue.size()).toBe(0);
  });

  it("converts a client-reported error into a null result for the pipeline", async () => {
    const queue = new EnrichmentQueue({ logger: nullLogger() });
    const enrichPromise = queue.enrich({
      type: "categorize",
      payload: { content: "x" },
    });
    const drained = queue.drain();
    queue.submit(drained[0]!.id, {
      error: { code: "provider_error", message: "boom" },
    });
    const result = await enrichPromise;
    expect(result).toBeNull();
  });

  it("submit() returns false for unknown ids", () => {
    const queue = new EnrichmentQueue({ logger: nullLogger() });
    expect(queue.submit("does-not-exist", null)).toBe(false);
  });

  it("rejects new requests when the queue is full", async () => {
    const queue = new EnrichmentQueue({
      logger: nullLogger(),
      maxPending: 1,
    });
    const _firstPromise = queue.enrich({
      type: "summarize",
      payload: { content: "a" },
    });
    const second = await queue.enrich({
      type: "summarize",
      payload: { content: "b" },
    });
    expect(second).toBeNull();
    expect(queue.size()).toBe(1);
    // Avoid leaking the first promise
    queue.shutdown();
    await _firstPromise;
  });
});

describe("pending_enrichment_requests tool", () => {
  it("returns enabled=false when no queue is wired", async () => {
    const ctx = await makeCtx();
    const parsed = pendingEnrichmentRequests.inputSchema.parse({});
    const res = (await pendingEnrichmentRequests.handler(parsed, ctx)) as {
      enabled: boolean;
      requests: unknown[];
    };
    expect(res.enabled).toBe(false);
    expect(res.requests).toEqual([]);
  });

  it("drains queued requests up to the limit", async () => {
    const queue = new EnrichmentQueue({ logger: nullLogger() });
    void queue.enrich({ type: "summarize", payload: { content: "a" } });
    void queue.enrich({ type: "categorize", payload: { content: "b" } });
    void queue.enrich({
      type: "tag_entities",
      payload: { content: "c" },
    });
    const ctx = await makeCtx(queue);
    const parsed = pendingEnrichmentRequests.inputSchema.parse({ limit: 2 });
    const res = (await pendingEnrichmentRequests.handler(parsed, ctx)) as {
      enabled: boolean;
      remaining: number;
      requests: Array<{ type: string }>;
    };
    expect(res.enabled).toBe(true);
    expect(res.requests).toHaveLength(2);
    expect(res.requests[0]?.type).toBe("summarize");
    expect(res.remaining).toBe(3);
    queue.shutdown();
  });
});

describe("submit_enrichment_result tool", () => {
  it("returns no_queue when Cortex has no enrichment queue", async () => {
    const ctx = await makeCtx();
    const parsed = submitEnrichmentResult.inputSchema.parse({
      id: "abc",
      result: { summary: "x", key_points: [] },
    });
    const res = (await submitEnrichmentResult.handler(parsed, ctx)) as {
      accepted: boolean;
      reason: string;
    };
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("no_queue");
  });

  it("posts the result back to the waiting pipeline", async () => {
    const queue = new EnrichmentQueue({ logger: nullLogger() });
    const enrichPromise = queue.enrich({
      type: "summarize",
      payload: { content: "x" },
    });
    const drained = queue.drain();
    const ctx = await makeCtx(queue);
    const parsed = submitEnrichmentResult.inputSchema.parse({
      id: drained[0]!.id,
      result: { summary: "got it", key_points: [] },
    });
    const res = (await submitEnrichmentResult.handler(parsed, ctx)) as {
      accepted: boolean;
      reason: string;
    };
    expect(res.accepted).toBe(true);
    expect(res.reason).toBe("ok");
    const pipelineResult = await enrichPromise;
    expect(pipelineResult).toEqual({ summary: "got it", key_points: [] });
  });

  it("returns unknown_id when the request id has expired or is unknown", async () => {
    const queue = new EnrichmentQueue({ logger: nullLogger() });
    const ctx = await makeCtx(queue);
    const parsed = submitEnrichmentResult.inputSchema.parse({
      id: "never-queued",
      result: { summary: "x", key_points: [] },
    });
    const res = (await submitEnrichmentResult.handler(parsed, ctx)) as {
      accepted: boolean;
      reason: string;
    };
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("unknown_id");
  });
});
