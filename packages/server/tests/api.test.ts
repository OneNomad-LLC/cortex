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
            date: new Date().toISOString(),
            tags: ["owner:matt", "due:2099-01-01", "status:open"],
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

  it("serves /api/widgets/priorities with a row that bubbles up", async () => {
    const res = await fetch(
      `${baseUrl}/api/widgets/priorities?limit=5`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ reason: string; content: string }>;
      generatedAt: string;
    };
    expect(body.generatedAt).toBeTruthy();
    // The fixture row has a 2099 due date but was just-nudged (date: now),
    // so it surfaces as "just-nudged" rather than "overdue".
    expect(body.rows.length).toBe(1);
    expect(body.rows[0]!.reason).toBe("just-nudged");
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
