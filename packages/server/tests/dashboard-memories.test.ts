/**
 * /api/dashboard/memories — list + detail. Stubs engram.search so the
 * route's filtering, multi-type fan-out, pagination, and dossier
 * derivation are the only things under test.
 *
 * Three load-bearing contracts we pin here:
 *
 *   1. Admin-gated: no bearer = 401.
 *   2. Type filters fan out and merge (and de-dup by id).
 *   3. Dossier rows are flagged when type=brief + tags contain "dossier".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handle as memoriesHandle } from "../src/api/routes/dashboard-memories.js";
import {
  bearerAuth,
  jsonFetch,
  startDashboardTestServer,
  type DashboardTestHarness,
} from "./dashboard-helpers.js";
import type {
  EngramClient,
  EngramMemory,
  EngramSearchArgs,
} from "../src/clients/engram.js";

let harness: DashboardTestHarness;
const ORIGINAL_ENV = { ...process.env };
let calls: EngramSearchArgs[];

function memory(
  id: string,
  type: string,
  source: string,
  opts: { content?: string; tags?: string[]; project?: string; date?: string } = {},
): EngramMemory {
  const date = opts.date ?? "2026-04-12T00:00:00.000Z";
  return {
    id,
    content: opts.content ?? `body of ${id}`,
    type,
    createdAt: date,
    tags: opts.tags ?? [],
    metadata: {
      type,
      source,
      source_id: id,
      date,
      ...(opts.project ? { project: opts.project } : {}),
      ...(opts.tags && opts.tags.length > 0 ? { tags: opts.tags } : {}),
    },
  };
}

const DOSSIER = memory("mem-dossier", "brief", "github", {
  content: "# Cortex\n\nKnowledge-engine brief.",
  tags: ["dossier", "project:cortex", "source:github"],
  project: "cortex",
});

const DOC = memory("mem-doc", "doc", "manual", {
  content: "doc body",
  tags: ["project:ops"],
  project: "ops",
});

const NOTE = memory("mem-note", "note", "manual", {
  content: "raw note",
  tags: [],
});

function fakeEngram(rowsByType: Record<string, EngramMemory[]>): EngramClient {
  return {
    async ingest() {
      return { id: "x" };
    },
    async search(args) {
      calls.push(args);
      const all = Object.values(rowsByType).flat();
      let filtered = all;
      if (args.type) {
        filtered = filtered.filter((r) => {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          return meta.type === args.type;
        });
      }
      if (args.source) {
        filtered = filtered.filter((r) => {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          return meta.source === args.source;
        });
      }
      if (args.project) {
        filtered = filtered.filter((r) => {
          const tags = r.tags ?? [];
          return tags.includes(`project:${args.project}`);
        });
      }
      if (args.sinceIso) {
        filtered = filtered.filter((r) => (r.createdAt ?? "") >= args.sinceIso!);
      }
      return filtered;
    },
    async healthCheck() {
      return { healthy: true, message: "" };
    },
    async shutdown() {
      return;
    },
    async wipeAll() {
      return { deleted: 0 };
    },
    // eslint-disable-next-line require-yield
    async *exportAll() {
      return;
    },
  };
}

beforeEach(async () => {
  calls = [];
  const engram = fakeEngram({
    brief: [DOSSIER],
    doc: [DOC],
    note: [NOTE],
  });
  harness = await startDashboardTestServer([memoriesHandle], { engram });
});

afterEach(async () => {
  await harness.cleanup();
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/dashboard/memories", () => {
  it("returns 401 without auth", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/memories");
    expect(resp.status).toBe(401);
  });

  it("lists every memory and flags dossier rows", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/memories", {
      headers: bearerAuth(harness.rawToken),
    });
    expect(resp.status).toBe(200);
    const body = resp.body as {
      memories: Array<{
        id: string;
        type: string;
        isDossier: boolean;
        tags: string[];
        source: string;
      }>;
      total: number;
    };
    expect(body.total).toBe(3);
    const byId = Object.fromEntries(body.memories.map((m) => [m.id, m]));
    expect(byId["mem-dossier"]?.isDossier).toBe(true);
    expect(byId["mem-doc"]?.isDossier).toBe(false);
    expect(byId["mem-doc"]?.source).toBe("manual");
  });

  it("multi-type filter fans out + dedupes, narrowing to the selected types", async () => {
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/memories?type=brief&type=doc",
      { headers: bearerAuth(harness.rawToken) },
    );
    expect(resp.status).toBe(200);
    const body = resp.body as {
      memories: Array<{ id: string }>;
      total: number;
    };
    expect(body.total).toBe(2);
    const ids = body.memories.map((m) => m.id).sort();
    expect(ids).toEqual(["mem-doc", "mem-dossier"]);
    // Each requested type triggered its own search call.
    const typesQueried = calls.map((c) => c.type).filter(Boolean).sort();
    expect(typesQueried).toEqual(["brief", "doc"]);
  });

  it("invalid type values are dropped (no 400, no extra search)", async () => {
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/memories?type=bogus",
      { headers: bearerAuth(harness.rawToken) },
    );
    expect(resp.status).toBe(200);
    // With no valid types, the route runs a single unfiltered query.
    const typesQueried = calls.map((c) => c.type).filter(Boolean);
    expect(typesQueried).toEqual([]);
  });

  it("detail route returns the full content + tags", async () => {
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/memories/mem-dossier",
      { headers: bearerAuth(harness.rawToken) },
    );
    expect(resp.status).toBe(200);
    const body = resp.body as {
      memory: { id: string; content: string; isDossier: boolean; tags: string[] };
    };
    expect(body.memory.id).toBe("mem-dossier");
    expect(body.memory.content).toContain("Knowledge-engine brief");
    expect(body.memory.isDossier).toBe(true);
    expect(body.memory.tags).toContain("dossier");
  });

  it("detail 404s for an unknown id", async () => {
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/memories/does-not-exist",
      { headers: bearerAuth(harness.rawToken) },
    );
    expect(resp.status).toBe(404);
  });
});
