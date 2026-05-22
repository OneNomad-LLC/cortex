/**
 * /api/dashboard/logs — server-side filter coverage. The route reads
 * from the shared in-memory log bus + the runtime.log on disk; tests
 * here only seed the bus so they don't depend on the dev's runtime.log.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handle as logsHandle } from "../src/api/routes/dashboard-logs.js";
import {
  bearerAuth,
  jsonFetch,
  startDashboardTestServer,
  type DashboardTestHarness,
} from "./dashboard-helpers.js";
import { getSharedLogBus } from "../src/log-bus.js";

let harness: DashboardTestHarness;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  harness = await startDashboardTestServer([logsHandle], {});
  // Wipe + seed the in-memory ring. Cast around the EventEmitter
  // surface — tests are the only caller that pokes at internals.
  const bus = getSharedLogBus() as unknown as { ring: unknown[] };
  bus.ring.length = 0;
  // Spread of timestamps so the `since` filter has something to bite.
  getSharedLogBus().append({ ts: "2026-05-20T10:00:00.000Z", level: "info", msg: "boot", component: "scheduler" });
  getSharedLogBus().append({ ts: "2026-05-20T10:01:00.000Z", level: "warn", msg: "slow query", adapter: "loom" });
  getSharedLogBus().append({ ts: "2026-05-20T10:02:00.000Z", level: "error", msg: "oom", adapter: "loom" });
  getSharedLogBus().append({ ts: "2026-05-20T10:03:00.000Z", level: "info", msg: "tick", adapter: "github" });
  // Point the runtime.log resolver at a path that doesn't exist so we
  // only exercise the ring buffer here.
  process.env.PRZM_CORTEX_HOME = "/nonexistent-cortex-home-for-logs-test";
});

afterEach(async () => {
  await harness.cleanup();
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/dashboard/logs", () => {
  it("returns 401 without auth", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/logs");
    expect(resp.status).toBe(401);
  });

  it("returns the ring buffer when authed", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/logs", {
      headers: bearerAuth(harness.rawToken),
    });
    expect(resp.status).toBe(200);
    const body = resp.body as { lines: Array<Record<string, unknown>>; matched: number };
    // All 4 seeded lines.
    expect(body.lines.length).toBe(4);
    expect(body.matched).toBe(4);
  });

  it("filters by level", async () => {
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/logs?level=warn",
      { headers: bearerAuth(harness.rawToken) },
    );
    const body = resp.body as { lines: Array<{ msg: string }> };
    expect(body.lines.map((l) => l.msg)).toEqual(["slow query"]);
  });

  it("filters by adapter", async () => {
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/logs?adapter=loom",
      { headers: bearerAuth(harness.rawToken) },
    );
    const body = resp.body as { lines: Array<{ msg: string }> };
    expect(body.lines.map((l) => l.msg).sort()).toEqual(["oom", "slow query"]);
  });

  it("filters by since (lexicographic ISO compare)", async () => {
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/logs?since=2026-05-20T10:01:30.000Z",
      { headers: bearerAuth(harness.rawToken) },
    );
    const body = resp.body as { lines: Array<{ msg: string; ts: string }> };
    expect(body.lines.map((l) => l.msg)).toEqual(["oom", "tick"]);
  });

  it("respects limit (newest-N) when more lines match than limit", async () => {
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/logs?limit=2",
      { headers: bearerAuth(harness.rawToken) },
    );
    const body = resp.body as { lines: Array<{ ts: string }>; matched: number };
    expect(body.lines.length).toBe(2);
    expect(body.matched).toBe(4);
    // Newest 2 — by ts.
    expect(body.lines[0]?.ts).toBe("2026-05-20T10:02:00.000Z");
    expect(body.lines[1]?.ts).toBe("2026-05-20T10:03:00.000Z");
  });
});
