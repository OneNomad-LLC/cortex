import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadTaxonomy } from "../src/taxonomy.js";
import { digest } from "../src/mcp/tools/digest.js";
import type { ToolContext } from "../src/mcp/tool.js";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

/**
 * digest makes ~6 parallel Engram search calls. This stub returns a
 * different response for each call based on the `type` filter — makes
 * the test self-explanatory.
 */
function routedEngram(responses: {
  events?: EngramMemory[];
  actionItems?: EngramMemory[];
  decisions?: EngramMemory[];
  briefs?: EngramMemory[];
  other?: EngramMemory[];
  unclassified?: EngramMemory[];
}): EngramClient {
  const search = vi.fn(async (args: { type?: string; query?: string }) => {
    if (args.type === "event") return responses.events ?? [];
    if (args.type === "action_item") return responses.actionItems ?? [];
    if (args.type === "decision") return responses.decisions ?? [];
    if (args.type === "brief") return responses.briefs ?? [];
    if (args.query === "unclassified") return responses.unclassified ?? [];
    return responses.other ?? [];
  });
  return {
    ingest: vi.fn(async () => ({ id: "fake" })),
    search,
    healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    shutdown: vi.fn(async () => undefined),
  };
}

async function makeCtx(
  responses: Parameters<typeof routedEngram>[0] = {},
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
    engram: routedEngram(responses),
    persona: {
      cognitiveLoad: vi.fn(async () => "medium"),
      signal: vi.fn(async () => undefined),
      healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
      shutdown: vi.fn(async () => undefined),
    },
  };
}

describe("digest", () => {
  it("composes upcoming events, action items (split overdue), and recent activity", async () => {
    const now = new Date();
    const in2h = new Date(now.getTime() + 2 * 3_600_000);
    const yesterday = new Date(now.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const nextWeek = new Date(now.getTime() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const ctx = await makeCtx({
      events: [
        {
          id: "e1",
          content: "Alpha standup",
          metadata: {
            type: "event",
            title: "Alpha standup",
            start: in2h.toISOString(),
          },
        },
      ],
      actionItems: [
        {
          id: "a1",
          content: "Overdue task",
          metadata: {
            type: "action_item",
            source_id: "x#a1",
            tags: ["owner:alex", `due:${yesterday}`],
          },
        },
        {
          id: "a2",
          content: "Upcoming task",
          metadata: {
            type: "action_item",
            source_id: "x#a2",
            tags: ["owner:alex", `due:${nextWeek}`],
          },
        },
        {
          id: "a3",
          content: "Done thing",
          metadata: {
            type: "action_item",
            source_id: "x#a3",
            tags: ["owner:alex", "status:done"],
          },
        },
      ],
      decisions: [
        {
          id: "d1",
          content: "Ship Friday.",
          metadata: { type: "decision", title: "Ship Friday" },
        },
      ],
      briefs: [
        {
          id: "b1",
          content: "# Weekly",
          metadata: { type: "brief", title: "Weekly sync" },
        },
      ],
      other: [],
      unclassified: [
        {
          id: "u1",
          content: "?",
          metadata: { project: [], confidence: 0 },
        },
      ],
    });

    const parsed = digest.inputSchema.parse({ assignee: "alex" });
    const res = (await digest.handler(parsed, ctx)) as {
      upcoming: Array<{ title?: string }>;
      openActionItems: Array<{ content: string; assignee?: string }>;
      overdueActionItems: Array<{ content: string }>;
      recent: { decisions: unknown[]; briefs: unknown[] };
      unclassifiedQueueSize?: number;
      summary: {
        upcomingCount: number;
        actionItemsOpen: number;
        actionItemsOverdue: number;
      };
    };

    expect(res.upcoming.map((e) => e.title)).toEqual(["Alpha standup"]);
    expect(res.openActionItems.map((a) => a.content)).toEqual(["Upcoming task"]);
    expect(res.openActionItems[0]?.assignee).toBe("alex");
    expect(res.overdueActionItems.map((a) => a.content)).toEqual(["Overdue task"]);
    expect(res.recent.decisions).toHaveLength(1);
    expect(res.recent.briefs).toHaveLength(1);
    expect(res.unclassifiedQueueSize).toBe(1);
    expect(res.summary.upcomingCount).toBe(1);
    expect(res.summary.actionItemsOpen).toBe(1);
    expect(res.summary.actionItemsOverdue).toBe(1);
  });

  it("assignee resolves via taxonomy aliases and filters action items accordingly", async () => {
    const ctx = await makeCtx({
      actionItems: [
        {
          id: "a1",
          content: "Alex thing",
          metadata: {
            type: "action_item",
            source_id: "x#a1",
            tags: ["owner:alex"],
          },
        },
        {
          id: "a2",
          content: "Sarah thing",
          metadata: {
            type: "action_item",
            source_id: "x#a2",
            tags: ["owner:sarah"],
          },
        },
      ],
    });

    // "Alexander" is an alias for alex in the fixture.
    const parsed = digest.inputSchema.parse({ assignee: "Alexander" });
    const res = (await digest.handler(parsed, ctx)) as {
      openActionItems: Array<{ content: string }>;
    };
    expect(res.openActionItems.map((a) => a.content)).toEqual(["Alex thing"]);
  });

  it("includeUnclassified:false omits the queue count", async () => {
    const ctx = await makeCtx({ unclassified: [] });
    const parsed = digest.inputSchema.parse({
      includeUnclassified: false,
    });
    const res = (await digest.handler(parsed, ctx)) as {
      unclassifiedQueueSize?: number;
    };
    expect(res.unclassifiedQueueSize).toBeUndefined();
  });

  it("respects an explicit since/until window in the response", async () => {
    const ctx = await makeCtx({});
    const since = "2026-04-01T00:00:00.000Z";
    const until = "2026-05-01T00:00:00.000Z";
    const parsed = digest.inputSchema.parse({ since, until });
    const res = (await digest.handler(parsed, ctx)) as {
      window: { since: string; until: string };
    };
    expect(res.window.since).toBe(since);
    expect(res.window.until).toBe(until);
  });
});
