import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadTaxonomy } from "../src/taxonomy.js";
import { pendingActionItems } from "../src/mcp/tools/pending-action-items.js";
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

describe("pending_action_items", () => {
  it("filters by assignee tag and sorts by due date (undated last)", async () => {
    const ctx = await makeCtx([
      {
        id: "a",
        content: "- [ ] Book sync",
        metadata: {
          type: "action_item",
          source_id: "x#a",
          tags: ["owner:alex", "due:2026-04-25"],
        },
      },
      {
        id: "b",
        content: "- [ ] Migrate DB",
        metadata: {
          type: "action_item",
          source_id: "x#b",
          tags: ["owner:alex", "due:2026-04-23"],
        },
      },
      {
        id: "c",
        content: "- [ ] Write spec",
        metadata: {
          type: "action_item",
          source_id: "x#c",
          tags: ["owner:alex"], // undated
        },
      },
      {
        id: "d",
        content: "- [ ] Not alex's item",
        metadata: {
          type: "action_item",
          source_id: "x#d",
          tags: ["owner:sarah", "due:2026-04-22"],
        },
      },
    ]);

    const parsed = pendingActionItems.inputSchema.parse({ assignee: "alex" });
    const res = (await pendingActionItems.handler(parsed, ctx)) as {
      open: Array<{ content: string; due?: string; assignee?: string }>;
    };

    expect(res.open).toHaveLength(3);
    // Earliest due first.
    expect(res.open[0]?.due).toBe("2026-04-23");
    expect(res.open[1]?.due).toBe("2026-04-25");
    // Undated last.
    expect(res.open[2]?.due).toBeUndefined();
    // assignee field surfaces from owner tag (renamed in 0.2).
    expect(res.open[0]?.assignee).toBe("alex");
  });

  it("treats status:done as closed and excludes by default", async () => {
    const ctx = await makeCtx([
      {
        id: "a",
        content: "- [x] Shipped",
        metadata: {
          type: "action_item",
          source_id: "x#a",
          tags: ["owner:alex", "status:done"],
        },
      },
      {
        id: "b",
        content: "- [ ] Open",
        metadata: {
          type: "action_item",
          source_id: "x#b",
          tags: ["owner:alex"],
        },
      },
    ]);

    const parsed = pendingActionItems.inputSchema.parse({ assignee: "alex" });
    const res = (await pendingActionItems.handler(parsed, ctx)) as {
      open: unknown[];
      done?: unknown[];
    };
    expect(res.open).toHaveLength(1);
    expect(res.done).toBeUndefined();

    const withDone = (await pendingActionItems.handler(
      pendingActionItems.inputSchema.parse({
        assignee: "alex",
        includeDone: true,
      }),
      ctx,
    )) as { open: unknown[]; done?: unknown[] };
    expect(withDone.done).toHaveLength(1);
  });

  it("resolves assignee aliases / name via taxonomy", async () => {
    const ctx = await makeCtx([
      {
        id: "a",
        content: "- [ ] do thing",
        metadata: {
          type: "action_item",
          source_id: "x#a",
          tags: ["owner:alex"],
        },
      },
    ]);

    // "Alex Example" is the fixture's canonical name for slug "alex"
    // with alias "Alexander" — findPerson should map either back to "alex".
    const parsed = pendingActionItems.inputSchema.parse({
      assignee: "Alexander",
    });
    const res = (await pendingActionItems.handler(parsed, ctx)) as {
      assignee?: string;
      open: unknown[];
    };
    expect(res.assignee).toBe("alex");
    expect(res.open).toHaveLength(1);
  });

  it("returns hint when project lookup fails", async () => {
    const ctx = await makeCtx();
    const parsed = pendingActionItems.inputSchema.parse({ project: "ghost" });
    const res = (await pendingActionItems.handler(parsed, ctx)) as {
      hint?: string;
    };
    expect(res.hint).toContain("ghost");
  });

  it("respects an explicit `since` ISO timestamp", async () => {
    const ctx = await makeCtx([]);
    const sinceIso = "2026-03-01T00:00:00.000Z";
    const parsed = pendingActionItems.inputSchema.parse({ since: sinceIso });
    const res = (await pendingActionItems.handler(parsed, ctx)) as {
      since: string;
    };
    expect(res.since).toBe(sinceIso);
  });
});
