import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadTaxonomy } from "../src/taxonomy.js";
import { listUnclassified } from "../src/mcp/tools/list-unclassified.js";
import type { ToolContext } from "../src/mcp/tool.js";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function fakeEngram(memories: EngramMemory[] = []): EngramClient {
  return {
    ingest: vi.fn(async () => ({ id: "fake" })),
    search: vi.fn(async () => memories),
    healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    shutdown: vi.fn(async () => undefined),
  };
}

async function makeCtx(memories: EngramMemory[] = []): Promise<ToolContext> {
  const taxonomy = await loadTaxonomy({
    projectsPath: path.join(fixturesDir, "projects.yaml"),
    peoplePath: path.join(fixturesDir, "people.yaml"),
  });
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return logger;
    },
  };
  return {
    taxonomy,
    logger,
    engram: fakeEngram(memories),
    persona: {
      cognitiveLoad: vi.fn(async () => "medium"),
      signal: vi.fn(async () => undefined),
      healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
      shutdown: vi.fn(async () => undefined),
    },
  };
}

describe("list_unclassified", () => {
  it("picks items with empty project or confidence <= threshold and groups by source", async () => {
    const ctx = await makeCtx([
      {
        id: "m1",
        content: "Unclassified slack thread",
        metadata: {
          type: "conversation",
          source: "slack",
          project: [],
          confidence: 0,
          source_id: "slack:thread:1",
        },
      },
      {
        id: "m2",
        content: "Low-confidence Notion doc",
        metadata: {
          type: "doc",
          source: "notion",
          project: "engineering",
          confidence: 0.35,
          source_id: "notion:page:2",
        },
      },
      {
        id: "m3",
        content: "Confidently classified Confluence doc",
        metadata: {
          type: "doc",
          source: "confluence",
          project: "engineering",
          confidence: 0.95,
          source_id: "confluence:page:3",
        },
      },
    ]);

    const parsed = listUnclassified.inputSchema.parse({
      confidenceMax: 0.5,
    });
    const res = (await listUnclassified.handler(parsed, ctx)) as {
      totalQueued: number;
      bySource: Array<{ source: string; count: number }>;
    };
    expect(res.totalQueued).toBe(2);
    const sources = res.bySource.map((s) => s.source).sort();
    expect(sources).toEqual(["notion", "slack"]);
  });

  it("returns a helpful hint when nothing is queued", async () => {
    const ctx = await makeCtx([
      {
        id: "m1",
        content: "High confidence",
        metadata: {
          type: "doc",
          source: "confluence",
          project: "engineering",
          confidence: 0.95,
        },
      },
    ]);

    const parsed = listUnclassified.inputSchema.parse({});
    const res = (await listUnclassified.handler(parsed, ctx)) as {
      totalQueued: number;
      hint?: string;
    };
    expect(res.totalQueued).toBe(0);
    expect(res.hint).toContain("Nothing queued");
  });

  it("filters by source when specified", async () => {
    const ctx = await makeCtx([
      {
        id: "a",
        content: "slack",
        metadata: { type: "conversation", source: "slack", project: [], confidence: 0 },
      },
    ]);
    const parsed = listUnclassified.inputSchema.parse({ source: "slack" });
    const res = (await listUnclassified.handler(parsed, ctx)) as {
      totalQueued: number;
    };
    expect(res.totalQueued).toBe(1);
    const call = (ctx.engram.search as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.source).toBe("slack");
  });
});
