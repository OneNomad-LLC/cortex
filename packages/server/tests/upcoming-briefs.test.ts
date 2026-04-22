import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadTaxonomy } from "../src/taxonomy.js";
import { upcomingBriefs } from "../src/mcp/tools/upcoming-briefs.js";
import type { ToolContext } from "../src/mcp/tool.js";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function fakeEngram(memoriesByCall: EngramMemory[][] = []): EngramClient {
  let idx = 0;
  const search = vi.fn(async () => {
    const page = memoriesByCall[idx] ?? [];
    idx++;
    return page;
  });
  return {
    ingest: vi.fn(async () => ({ id: "fake" })),
    search,
    healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    shutdown: vi.fn(async () => undefined),
  };
}

async function makeCtx(
  memoriesByCall: EngramMemory[][] = [],
  withLLM = false,
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
    engram: fakeEngram(memoriesByCall),
    persona: {
      cognitiveLoad: vi.fn(async () => "medium"),
      signal: vi.fn(async () => undefined),
      healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
      shutdown: vi.fn(async () => undefined),
    },
    ...(withLLM
      ? {
          llmRouter: {
            complete: vi.fn(async () => ({
              content: "# Generated brief\n\n- item",
              model: "test",
              provider: "test",
              latencyMs: 1,
            })),
          } as never,
        }
      : {}),
  };
}

describe("upcoming_briefs", () => {
  it("returns events within the hoursAhead window, sorted by start", async () => {
    const now = new Date();
    const in30m = new Date(now.getTime() + 30 * 60 * 1000);
    const in4h = new Date(now.getTime() + 4 * 3_600_000);
    const in72h = new Date(now.getTime() + 72 * 3_600_000);

    const events: EngramMemory[] = [
      {
        id: "e1",
        content: "Later event out of window",
        metadata: {
          type: "event",
          title: "Far",
          start: in72h.toISOString(),
        },
      },
      {
        id: "e2",
        content: "Project Alpha standup",
        metadata: {
          type: "event",
          title: "Standup",
          start: in4h.toISOString(),
          project: "project-alpha",
        },
      },
      {
        id: "e3",
        content: "Quick sync",
        metadata: {
          type: "event",
          title: "Sync",
          start: in30m.toISOString(),
        },
      },
    ];

    // First search call is for events; subsequent four calls (per-event
    // gatherContext) each return an empty list.
    const ctx = await makeCtx([events, [], [], [], [], [], [], [], []]);
    const parsed = upcomingBriefs.inputSchema.parse({
      hoursAhead: 24,
      generateBrief: false,
    });
    const res = (await upcomingBriefs.handler(parsed, ctx)) as {
      events: Array<{ eventId: string; title?: string; start?: string; brief?: string }>;
    };

    expect(res.events.map((e) => e.eventId)).toEqual(["e3", "e2"]);
    // Sorted earliest-first.
    expect(res.events[0]?.title).toBe("Sync");
    expect(res.events[1]?.title).toBe("Standup");
    expect(res.events[0]?.brief).toBeUndefined();
  });

  it("respects minutesThreshold to gate events close to happening", async () => {
    const now = new Date();
    const in15m = new Date(now.getTime() + 15 * 60 * 1000);
    const in3h = new Date(now.getTime() + 3 * 3_600_000);

    const events: EngramMemory[] = [
      {
        id: "close",
        content: "Imminent",
        metadata: { type: "event", title: "Imminent", start: in15m.toISOString() },
      },
      {
        id: "later",
        content: "Later today",
        metadata: { type: "event", title: "Later", start: in3h.toISOString() },
      },
    ];
    const ctx = await makeCtx([events, [], [], [], [], [], [], [], []]);

    const parsed = upcomingBriefs.inputSchema.parse({
      hoursAhead: 24,
      minutesThreshold: 30,
      generateBrief: false,
    });
    const res = (await upcomingBriefs.handler(parsed, ctx)) as {
      events: Array<{ eventId: string }>;
    };
    expect(res.events.map((e) => e.eventId)).toEqual(["close"]);
  });

  it("calls the LLM router when generateBrief=true and one is configured", async () => {
    const now = new Date();
    const in1h = new Date(now.getTime() + 3_600_000);
    const events: EngramMemory[] = [
      {
        id: "e",
        content: "Planning",
        metadata: {
          type: "event",
          title: "Planning",
          start: in1h.toISOString(),
        },
      },
    ];
    const ctx = await makeCtx([events, [], [], [], [], [], [], [], []], true);

    const parsed = upcomingBriefs.inputSchema.parse({});
    const res = (await upcomingBriefs.handler(parsed, ctx)) as {
      events: Array<{ brief?: string }>;
    };
    expect(res.events[0]?.brief).toContain("Generated brief");
    expect((ctx.llmRouter!.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("returns a hint when project lookup fails", async () => {
    const ctx = await makeCtx();
    const parsed = upcomingBriefs.inputSchema.parse({ project: "ghost" });
    const res = (await upcomingBriefs.handler(parsed, ctx)) as { hint?: string };
    expect(res.hint).toContain("ghost");
  });
});
