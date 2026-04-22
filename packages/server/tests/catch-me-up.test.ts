import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadTaxonomy } from "../src/taxonomy.js";
import { catchMeUp } from "../src/mcp/tools/catch-me-up.js";
import { catchMeUpOnMeeting } from "../src/mcp/tools/catch-me-up-on-meeting.js";
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

async function makeCtx(
  memories: EngramMemory[] = [],
): Promise<ToolContext> {
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

describe("catch_me_up", () => {
  it("groups memories by type in deterministic order", async () => {
    const ctx = await makeCtx([
      {
        id: "1",
        content: "Decided to ship Friday.",
        metadata: {
          type: "decision",
          title: "Ship Friday",
          date: "2026-04-20",
        },
      },
      {
        id: "2",
        content: "Onboarding doc.",
        metadata: { type: "doc", title: "Onboarding", date: "2026-04-19" },
      },
      {
        id: "3",
        content: "Weekly sync brief.",
        metadata: { type: "brief", title: "Weekly", date: "2026-04-21" },
      },
    ]);

    const parsed = catchMeUp.inputSchema.parse({ project: "project-alpha" });
    const res = (await catchMeUp.handler(parsed, ctx)) as {
      buckets: Array<{ type: string; items: Array<{ title?: string }> }>;
      totalMemories: number;
    };

    expect(res.totalMemories).toBe(3);
    // Brief before decision before doc per typeOrder.
    expect(res.buckets.map((b) => b.type)).toEqual(["brief", "decision", "doc"]);
  });

  it("returns a hint when project lookup fails", async () => {
    const ctx = await makeCtx();
    const parsed = catchMeUp.inputSchema.parse({ project: "ghost" });
    const res = (await catchMeUp.handler(parsed, ctx)) as { hint?: string };
    expect(res.hint).toContain("ghost");
  });

  it("filters by types when provided", async () => {
    const ctx = await makeCtx([
      { id: "1", content: "a", metadata: { type: "decision" } },
      { id: "2", content: "b", metadata: { type: "doc" } },
      { id: "3", content: "c", metadata: { type: "brief" } },
    ]);
    const parsed = catchMeUp.inputSchema.parse({
      types: ["decision", "brief"],
    });
    const res = (await catchMeUp.handler(parsed, ctx)) as {
      buckets: Array<{ type: string }>;
    };
    expect(res.buckets.map((b) => b.type).sort()).toEqual(["brief", "decision"]);
  });

  it("works unscoped when project is blank", async () => {
    const ctx = await makeCtx([
      { id: "1", content: "x", metadata: { type: "decision" } },
    ]);
    const parsed = catchMeUp.inputSchema.parse({});
    const res = (await catchMeUp.handler(parsed, ctx)) as {
      projectSlug: string;
    };
    expect(res.projectSlug).toBe("");
    // Engram.search called without project filter.
    const call = (ctx.engram.search as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.project).toBeUndefined();
  });
});

describe("catch_me_up_on_meeting", () => {
  it("returns brief + decisions + action items sharing a source_id root", async () => {
    const ctx = await makeCtx([
      {
        id: "m1",
        content: "Alpha planning meeting transcript...",
        metadata: {
          type: "meeting",
          source_id: "loom:rec:xyz",
          source_url: "https://loom.example/xyz",
          title: "Alpha planning",
          date: "2026-04-22",
          source: "loom",
        },
      },
      {
        id: "m2",
        content: "# Alpha planning brief\n\nTL;DR...",
        metadata: {
          type: "brief",
          source_id: "loom:rec:xyz#brief",
        },
      },
      {
        id: "m3",
        content: "Ship Friday.",
        metadata: {
          type: "decision",
          source_id: "loom:rec:xyz#decision-0",
          tags: ["owner:alex"],
        },
      },
      {
        id: "m4",
        content: "- [ ] Book a sync with Karim.",
        metadata: {
          type: "action_item",
          source_id: "loom:rec:xyz#action-0",
          tags: ["owner:sarah", "due:2026-04-25"],
        },
      },
    ]);

    const parsed = catchMeUpOnMeeting.inputSchema.parse({
      sourceId: "loom:rec:xyz",
    });
    const res = (await catchMeUpOnMeeting.handler(parsed, ctx)) as {
      found: boolean;
      meeting?: { title?: string; url?: string };
      brief?: string;
      decisions: Array<{ owner?: string }>;
      action_items: Array<{ owner?: string; due?: string }>;
    };

    expect(res.found).toBe(true);
    expect(res.meeting?.title).toBe("Alpha planning");
    expect(res.meeting?.url).toBe("https://loom.example/xyz");
    expect(res.brief).toContain("Alpha planning brief");
    expect(res.decisions).toHaveLength(1);
    expect(res.decisions[0]?.owner).toBe("alex");
    expect(res.action_items).toHaveLength(1);
    expect(res.action_items[0]?.owner).toBe("sarah");
    expect(res.action_items[0]?.due).toBe("2026-04-25");
  });

  it("returns found=false when no meeting matches", async () => {
    const ctx = await makeCtx([]);
    const parsed = catchMeUpOnMeeting.inputSchema.parse({
      query: "nope",
    });
    const res = (await catchMeUpOnMeeting.handler(parsed, ctx)) as {
      found: boolean;
      hint?: string;
    };
    expect(res.found).toBe(false);
    expect(res.hint).toContain("nope");
  });

  it("asks for at least one input", async () => {
    const ctx = await makeCtx();
    const parsed = catchMeUpOnMeeting.inputSchema.parse({});
    const res = (await catchMeUpOnMeeting.handler(parsed, ctx)) as {
      found: boolean;
      hint?: string;
    };
    expect(res.found).toBe(false);
    expect(res.hint).toContain("sourceId");
  });
});
