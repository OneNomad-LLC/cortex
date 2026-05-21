/**
 * /api/dashboard/ingest/* — auth + shape coverage. Each endpoint
 * wraps the same MCP tool used by the stdio surface, so the route
 * test focuses on the contract the dashboard relies on:
 *
 *   - 401 without auth
 *   - URL ingest queues async and returns `{ jobId, queued }`
 *   - Raw content ingest runs sync and returns `{ ingested, sourceId }`
 *
 * The full ingest pipeline + auto-enrichment + per-tool detail are
 * covered by the tool's own tests (ingest-url.test.ts etc.).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handle as ingestHandle } from "../src/api/routes/dashboard-ingest.js";
import {
  bearerAuth,
  jsonFetch,
  startDashboardTestServer,
  type DashboardTestHarness,
} from "./dashboard-helpers.js";
import type { EngramClient } from "../src/clients/engram.js";
import { jobs } from "../src/mcp/jobs.js";
import { MemoryTypeRegistry } from "@onenomad/przm-cortex-core";
import { makeInMemoryJobsStorage } from "./fake-jobs-storage.js";
import type { JobsStorage } from "@onenomad/przm-cortex-cache-sqlite";

let harness: DashboardTestHarness;
let storage: JobsStorage;
const ORIGINAL_ENV = { ...process.env };

function fakeEngram(): EngramClient {
  return {
    async ingest() {
      return { id: "fake-mem-1" };
    },
    async search() {
      return [];
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

function fakeTaxonomy() {
  return {
    findProject: () => undefined,
    findPerson: () => undefined,
  } as unknown as Parameters<typeof startDashboardTestServer>[1] extends { taxonomy?: infer T } ? T : never;
}

beforeEach(async () => {
  jobs._reset();
  storage = makeInMemoryJobsStorage();
  jobs.setStorage(storage);
  jobs.setDefaultWorkspace("testws");
  const memoryTypes = new MemoryTypeRegistry();
  harness = await startDashboardTestServer([ingestHandle], {
    engram: fakeEngram(),
    taxonomy: fakeTaxonomy() as never,
    memoryTypes,
  });
});

afterEach(async () => {
  await harness.cleanup();
  storage.close();
  jobs._reset();
  process.env = { ...ORIGINAL_ENV };
});

describe("dashboard ingest", () => {
  it("rejects unauthenticated", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/ingest/url", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cortex-dashboard": "1" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(resp.status).toBe(401);
  });

  it("rejects writes without CSRF header", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/ingest/url", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearerAuth(harness.rawToken),
      },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(resp.status).toBe(403);
  });

  it("queues a URL ingest and returns a jobId", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/ingest/url", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
        ...bearerAuth(harness.rawToken),
      },
      body: JSON.stringify({ url: "https://example.com/docs" }),
    });
    expect(resp.status).toBe(200);
    const body = resp.body as { ok: boolean; jobId: string; queued: boolean };
    expect(body.ok).toBe(true);
    expect(typeof body.jobId).toBe("string");
    expect(body.queued).toBe(true);
    // The job is registered before the route returns.
    const job = jobs.get(body.jobId);
    expect(job).toBeDefined();
    expect(job?.kind).toBe("ingest_url");
  });

  it("ingests raw content synchronously and returns the result", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/ingest/content", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
        ...bearerAuth(harness.rawToken),
      },
      body: JSON.stringify({
        content: "Hello dashboard",
        sourceId: "dash://test/1",
        // `note` is pass-through (no chunking pipeline) and bypasses
        // the LLM enrichment path, so a minimal fake engram suffices.
        type: "note",
        sourceUrl: "https://example.com/note/1",
      }),
    });
    expect(resp.status).toBe(200);
    const body = resp.body as {
      ok: boolean;
      ingested: number;
      sourceId: string;
      memories: Array<unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.ingested).toBe(1);
    expect(body.sourceId).toBe("dash://test/1");
    expect(body.memories.length).toBe(1);
  });

  it("404s on an unknown subpath", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/ingest/unknown", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
        ...bearerAuth(harness.rawToken),
      },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(404);
  });
});
