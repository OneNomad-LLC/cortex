/**
 * /api/dashboard/jobs — listing + detail coverage. Also pins the
 * persistence round-trip: a job upserted via the in-memory registry
 * still surfaces after the in-memory map is wiped (simulated restart).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handle as jobsHandle } from "../src/api/routes/dashboard-jobs.js";
import {
  bearerAuth,
  jsonFetch,
  startDashboardTestServer,
  type DashboardTestHarness,
} from "./dashboard-helpers.js";
import { jobs } from "../src/mcp/jobs.js";
import { makeInMemoryJobsStorage } from "./fake-jobs-storage.js";
import type { JobsStorage } from "@onenomad/przm-cortex-cache-sqlite";

let harness: DashboardTestHarness;
let storage: JobsStorage;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  jobs._reset();
  storage = makeInMemoryJobsStorage();
  jobs.setStorage(storage);
  jobs.setDefaultWorkspace("testws");
  harness = await startDashboardTestServer([jobsHandle], {});
});

afterEach(async () => {
  await harness.cleanup();
  storage.close();
  jobs._reset();
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/dashboard/jobs", () => {
  it("returns 401 without auth", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/jobs");
    expect(resp.status).toBe(401);
  });

  it("lists in-flight jobs (queued + running)", async () => {
    const a = jobs.create({ kind: "ingest_url", workspace: "testws" });
    const b = jobs.create({ kind: "ingest_repo", workspace: "testws" });
    jobs.start(b.id);
    // c terminal — should NOT show up in in_progress.
    const c = jobs.create({ kind: "ingest_url", workspace: "testws" });
    jobs.complete(c.id, { ingested: 5 });

    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/jobs?status=in_progress",
      { headers: bearerAuth(harness.rawToken) },
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { jobs: Array<{ jobId: string; status: string }> };
    const ids = body.jobs.map((j) => j.jobId).sort();
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });

  it("lists recent (completed/failed within 24h)", async () => {
    const a = jobs.create({ kind: "ingest_url", workspace: "testws" });
    jobs.complete(a.id, { ingested: 1 });
    const b = jobs.create({ kind: "ingest_url", workspace: "testws" });
    jobs.fail(b.id, new Error("nope"));
    // c still running — excluded.
    jobs.create({ kind: "ingest_repo", workspace: "testws" });

    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/jobs?status=recent",
      { headers: bearerAuth(harness.rawToken) },
    );
    const body = resp.body as { jobs: Array<{ jobId: string; status: string }> };
    const statuses = body.jobs.map((j) => j.status).sort();
    expect(statuses).toEqual(["completed", "failed"]);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      jobs.create({ kind: "ingest_url", workspace: "testws" });
    }
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/jobs?limit=2",
      { headers: bearerAuth(harness.rawToken) },
    );
    const body = resp.body as { jobs: Array<unknown> };
    expect(body.jobs.length).toBe(2);
  });

  it("returns single job by id", async () => {
    const job = jobs.create({ kind: "ingest_url", workspace: "testws" });
    jobs.progress(job.id, { totalUnits: 10, doneUnits: 3, message: "fetching" });
    const resp = await jsonFetch(
      harness.baseUrl,
      `/api/dashboard/jobs/${job.id}`,
      { headers: bearerAuth(harness.rawToken) },
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { job: { jobId: string; progress: Record<string, unknown> } };
    expect(body.job.jobId).toBe(job.id);
    expect(body.job.progress).toEqual({ totalUnits: 10, doneUnits: 3, message: "fetching" });
  });

  it("returns 404 for unknown id", async () => {
    const resp = await jsonFetch(
      harness.baseUrl,
      `/api/dashboard/jobs/not-a-real-id`,
      { headers: bearerAuth(harness.rawToken) },
    );
    expect(resp.status).toBe(404);
  });

  it("survives an in-memory wipe (persistence round-trip)", async () => {
    const a = jobs.create({ kind: "ingest_url", workspace: "testws" });
    jobs.complete(a.id, { ingested: 7 });

    // Simulate process restart: clear in-memory, re-wire storage.
    jobs._reset();
    jobs.setStorage(storage);
    jobs.setDefaultWorkspace("testws");

    // Detail still resolves through the persistent store.
    const detail = await jsonFetch(
      harness.baseUrl,
      `/api/dashboard/jobs/${a.id}`,
      { headers: bearerAuth(harness.rawToken) },
    );
    expect(detail.status).toBe(200);
    const detailBody = detail.body as { job: { status: string } };
    expect(detailBody.job.status).toBe("completed");

    // Listing still includes it.
    const list = await jsonFetch(
      harness.baseUrl,
      `/api/dashboard/jobs?status=recent`,
      { headers: bearerAuth(harness.rawToken) },
    );
    const listBody = list.body as { jobs: Array<{ jobId: string }> };
    expect(listBody.jobs.find((j) => j.jobId === a.id)).toBeDefined();
  });
});
