/**
 * /api/dashboard/stats — shape + per-source counts. Stubs the engram
 * surface (healthCheck + search) so the route's wiring is the only
 * thing under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handle as statsHandle } from "../src/api/routes/dashboard-stats.js";
import {
  bearerAuth,
  jsonFetch,
  startDashboardTestServer,
  type DashboardTestHarness,
} from "./dashboard-helpers.js";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";

let harness: DashboardTestHarness;
const ORIGINAL_ENV = { ...process.env };

function row(id: string, source: string, date: string): EngramMemory {
  return {
    id,
    content: `chunk-${id}`,
    type: "doc",
    createdAt: date,
    metadata: { source, source_id: id, date },
  };
}

function fakeEngram(rowsBySource: Record<string, EngramMemory[]>): EngramClient {
  return {
    async ingest() {
      return { id: "x" };
    },
    async search(args) {
      const all = Object.values(rowsBySource).flat();
      let filtered = all;
      if (args.source) {
        filtered = filtered.filter((r) => {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          return meta.source === args.source;
        });
      }
      if (args.sinceIso) {
        filtered = filtered.filter((r) => (r.createdAt ?? "") >= args.sinceIso!);
      }
      return filtered;
    },
    async healthCheck() {
      return {
        healthy: true,
        message: "",
        lastSuccessAt: Date.UTC(2026, 4, 20, 10),
        details: { total_chunks: 42, total_size_bytes: 100_000 },
      } as never;
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
  const now = new Date();
  const today = now.toISOString();
  const lastWeek = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const lastYear = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const engram = fakeEngram({
    loom: [row("loom-1", "loom", today), row("loom-2", "loom", lastWeek)],
    github: [row("gh-1", "github", today)],
    obsidian: [row("ob-1", "obsidian", lastYear)],
  });
  harness = await startDashboardTestServer([statsHandle], { engram });
});

afterEach(async () => {
  await harness.cleanup();
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/dashboard/stats", () => {
  it("returns 401 without auth", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/stats");
    expect(resp.status).toBe(401);
  });

  it("returns kb stats + per-source counts + recent activity", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/stats", {
      headers: bearerAuth(harness.rawToken),
    });
    expect(resp.status).toBe(200);
    const body = resp.body as {
      kb: { healthy: boolean; total_chunks: number };
      sources: Array<{ source: string; count: number }>;
      recentActivity: { last24h: number; last7d: number };
    };
    expect(body.kb.healthy).toBe(true);
    expect(body.kb.total_chunks).toBe(42);
    const sourceMap = Object.fromEntries(
      body.sources.map((s) => [s.source, s.count]),
    );
    expect(sourceMap.loom).toBe(2);
    expect(sourceMap.github).toBe(1);
    expect(sourceMap.obsidian).toBe(1);
    // Last-year row is excluded from the 7d window.
    expect(body.recentActivity.last7d).toBe(3);
    expect(body.recentActivity.last24h).toBe(2);
  });
});
