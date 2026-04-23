import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboardApi, type DashboardApi } from "../src/api/server.js";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";
import type { Logger } from "@cortex/core";

function nullLogger(): Logger {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log;
}

function fakeEngram(rows: EngramMemory[]): EngramClient {
  return {
    async ingest() {
      return { id: "x" };
    },
    async search(args) {
      // Honor the type filter so priorities' parallel action_item +
      // decision searches don't see the same row twice.
      if (!args.type) return rows;
      return rows.filter((r) => {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
        return tags.includes(`type:${args.type}`) || r.type === args.type;
      });
    },
    async healthCheck() {
      return { healthy: true, message: "" };
    },
    async shutdown() {
      return;
    },
  };
}

function fakeTaxonomy() {
  return {
    projects: [],
    people: [],
    findProject: () => undefined,
    findPerson: () => undefined,
  } as unknown as ConstructorParameters<typeof Object>[0] & {
    findProject(q: string): { slug: string } | undefined;
    findPerson(q: string): { slug: string } | undefined;
  };
}

describe("dashboard API", () => {
  let api: DashboardApi;
  let baseUrl: string;

  beforeAll(async () => {
    const now = new Date().toISOString();
    api = createDashboardApi({
      host: "127.0.0.1",
      port: 0,
      logger: nullLogger(),
      engram: fakeEngram([
        {
          id: "m1",
          type: "action_item",
          content: "Send slides to Alex by Friday",
          metadata: {
            source_id: "s1",
            project: "alpha",
            source: "meeting",
            source_url: "https://example.com/m1",
            date: now,
            tags: ["owner:matt", "due:2099-01-01", "status:open"],
          },
        },
        {
          id: "m2",
          type: "action_item",
          content: "Review PR for billing refactor",
          metadata: {
            source_id: "s2",
            project: "beta",
            source: "bitbucket",
            date: now,
            tags: ["owner:alex", "status:open"],
          },
        },
        {
          id: "m3",
          type: "action_item",
          content: "Archive old onboarding docs",
          metadata: {
            source_id: "s3",
            project: "alpha",
            source: "note",
            date: now,
            tags: ["owner:matt", "status:done"],
          },
        },
        {
          id: "d1",
          type: "decision",
          content: "We will ship the new pricing tiers on May 1",
          metadata: {
            source_id: "dec1",
            project: "alpha",
            source: "meeting",
            source_url: "https://example.com/d1",
            date: now,
            people: ["matt", "alex"],
            tags: ["type:decision"],
          },
        },
      ]),
      llmRouter: {} as never,
      taxonomy: fakeTaxonomy() as never,
    });
    await api.start();
    const port = api.boundPort();
    if (port === undefined) throw new Error("api did not bind a port");
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await api.stop();
  });

  it("serves /health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; widgets: number };
    expect(body.ok).toBe(true);
    expect(body.widgets).toBeGreaterThan(0);
  });

  it("lists widgets at /api/widgets", async () => {
    const res = await fetch(`${baseUrl}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      widgets: Array<{ name: string; description: string }>;
    };
    expect(body.widgets.some((w) => w.name === "priorities")).toBe(true);
  });

  it("serves /api/widgets/priorities with rows that bubble up", async () => {
    const res = await fetch(
      `${baseUrl}/api/widgets/priorities?limit=5`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ reason: string; content: string }>;
      generatedAt: string;
    };
    expect(body.generatedAt).toBeTruthy();
    // m1 + m2 as just-nudged action_items (m3 is done → skipped), d1 as
    // fresh-decision. Sort order: just-nudged before fresh-decision, and
    // within just-nudged the row with a due date wins the tiebreak.
    expect(body.rows.length).toBe(3);
    expect(body.rows[0]!.reason).toBe("just-nudged");
    expect(body.rows[0]!.content).toContain("slides");
    expect(body.rows[2]!.reason).toBe("fresh-decision");
  });

  it("serves /api/widgets/my-action-items with only open items by default", async () => {
    const res = await fetch(
      `${baseUrl}/api/widgets/my-action-items?owner=matt`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      owner?: string;
      open: Array<{ status: string; content: string; owner?: string }>;
      done?: Array<unknown>;
    };
    expect(body.owner).toBe("matt");
    // Only m1 matches owner=matt and is open. m3 is matt but done.
    expect(body.open.length).toBe(1);
    expect(body.open[0]!.status).toBe("open");
    expect(body.open[0]!.content).toContain("slides");
    expect(body.done).toBeUndefined();
  });

  it("surfaces done items when my-action-items?includeDone=true", async () => {
    const res = await fetch(
      `${baseUrl}/api/widgets/my-action-items?owner=matt&includeDone=true`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      open: Array<unknown>;
      done?: Array<{ status: string; content: string }>;
    };
    expect(body.done).toBeDefined();
    expect(body.done!.length).toBe(1);
    expect(body.done![0]!.status).toBe("done");
    expect(body.done![0]!.content).toContain("onboarding");
  });

  it("serves /api/layout with the default delivery preset", async () => {
    const res = await fetch(`${baseUrl}/api/layout`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      role: string;
      widgets: Array<{ name: string }>;
    };
    expect(body.role).toBe("delivery");
    const names = body.widgets.map((w) => w.name);
    expect(names).toContain("priorities");
    expect(names).toContain("my-action-items");
    expect(names).toContain("recent-decisions");
  });

  it("serves /api/widgets/recent-decisions newest-first", async () => {
    const res = await fetch(
      `${baseUrl}/api/widgets/recent-decisions?days=30`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      since: string;
      rows: Array<{ content: string; people?: string[] }>;
    };
    expect(body.since).toBeTruthy();
    expect(body.rows.length).toBe(1);
    expect(body.rows[0]!.content).toContain("pricing tiers");
    expect(body.rows[0]!.people).toEqual(["matt", "alex"]);
  });

  it("404s on unknown widgets", async () => {
    const res = await fetch(`${baseUrl}/api/widgets/bogus`);
    expect(res.status).toBe(404);
  });

  it("responds to CORS preflight", async () => {
    const res = await fetch(`${baseUrl}/api/widgets/priorities`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
  });
});
