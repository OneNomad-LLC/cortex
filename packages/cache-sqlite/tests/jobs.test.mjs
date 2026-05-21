// node:test runner — node:sqlite isn't a builtin vite recognises, so
// staying on node:test keeps the cache-sqlite test surface aligned
// with the rest of the package.
//
// Run after `pnpm build`: `node --test tests/jobs.test.mjs`

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJobsStorage } from "../dist/jobs-storage.js";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "cortex-jobs-test-"));
  const path = join(dir, "jobs.db");
  return {
    path,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ }
    },
  };
}

function baseRow(overrides = {}) {
  const now = Date.now();
  return {
    jobId: `job-${Math.random().toString(36).slice(2, 10)}`,
    type: "ingest_url",
    workspace: "work",
    status: "queued",
    progress: null,
    error: null,
    createdAtMs: now,
    startedAtMs: null,
    finishedAtMs: null,
    ...overrides,
  };
}

test("schema migration adds cache_jobs idempotently", () => {
  const { path, cleanup } = tmpDb();
  try {
    openJobsStorage(path).close();
    const store = openJobsStorage(path);
    assert.equal(store.get("missing"), null);
    store.close();
  } finally {
    cleanup();
  }
});

test("upsert + get roundtrip preserves every field", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openJobsStorage(path);
    const row = baseRow({
      jobId: "abc",
      type: "ingest_url",
      workspace: "work",
      status: "running",
      progress: { totalUnits: 10, doneUnits: 3, message: "fetching" },
      startedAtMs: 1700000000000,
    });
    store.upsert(row);
    const hit = store.get("abc");
    assert.ok(hit);
    assert.equal(hit.jobId, "abc");
    assert.equal(hit.type, "ingest_url");
    assert.equal(hit.workspace, "work");
    assert.equal(hit.status, "running");
    assert.deepEqual(hit.progress, {
      totalUnits: 10,
      doneUnits: 3,
      message: "fetching",
    });
    assert.equal(hit.startedAtMs, 1700000000000);
    assert.equal(hit.finishedAtMs, null);
    store.close();
  } finally {
    cleanup();
  }
});

test("upsert with same job_id replaces the row", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openJobsStorage(path);
    store.upsert(baseRow({ jobId: "x", status: "queued" }));
    store.upsert(baseRow({
      jobId: "x",
      status: "completed",
      progress: { doneUnits: 100 },
      finishedAtMs: 1700000001000,
    }));
    const hit = store.get("x");
    assert.equal(hit.status, "completed");
    assert.deepEqual(hit.progress, { doneUnits: 100 });
    assert.equal(hit.finishedAtMs, 1700000001000);
    store.close();
  } finally {
    cleanup();
  }
});

test("list filters by status + workspace + sinceMs and sorts newest first", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openJobsStorage(path);
    const t0 = 1700000000000;
    store.upsert(baseRow({ jobId: "a", workspace: "work", status: "queued", createdAtMs: t0 }));
    store.upsert(baseRow({ jobId: "b", workspace: "work", status: "running", createdAtMs: t0 + 1 }));
    store.upsert(baseRow({ jobId: "c", workspace: "work", status: "completed", createdAtMs: t0 + 2 }));
    store.upsert(baseRow({ jobId: "d", workspace: "personal", status: "running", createdAtMs: t0 + 3 }));

    const running = store.list({ status: "running" });
    assert.equal(running.length, 2);
    // Newest first: d (workspace=personal, t0+3) before b (t0+1).
    assert.equal(running[0].jobId, "d");
    assert.equal(running[1].jobId, "b");

    const workOnly = store.list({ workspace: "work" });
    assert.deepEqual(workOnly.map((r) => r.jobId), ["c", "b", "a"]);

    const since = store.list({ sinceMs: t0 + 2 });
    assert.deepEqual(since.map((r) => r.jobId), ["d", "c"]);

    const both = store.list({ workspace: "work", status: "running" });
    assert.deepEqual(both.map((r) => r.jobId), ["b"]);

    store.close();
  } finally {
    cleanup();
  }
});

test("cleanup drops aged terminal rows but keeps live + recent ones", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openJobsStorage(path);
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    // Old completed → should be evicted.
    store.upsert(baseRow({
      jobId: "old-done",
      status: "completed",
      createdAtMs: now - 2 * week,
      finishedAtMs: now - 2 * week,
    }));
    // Recent failed → keep.
    store.upsert(baseRow({
      jobId: "fresh-fail",
      status: "failed",
      createdAtMs: now - 60_000,
      finishedAtMs: now - 30_000,
    }));
    // Old running → keep (not terminal — surfacing trouble beats silent drop).
    store.upsert(baseRow({
      jobId: "old-running",
      status: "running",
      createdAtMs: now - 2 * week,
      startedAtMs: now - 2 * week,
    }));

    const evicted = store.cleanup({ maxAgeMs: week, maxRows: 1000 });
    assert.equal(evicted, 1);
    assert.equal(store.get("old-done"), null);
    assert.ok(store.get("fresh-fail"));
    assert.ok(store.get("old-running"));
    store.close();
  } finally {
    cleanup();
  }
});

test("cleanup evicts oldest rows when total exceeds maxRows", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openJobsStorage(path);
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 10; i++) {
      store.upsert(baseRow({
        jobId: `j${i}`,
        status: "queued",
        createdAtMs: t0 + i,
      }));
    }
    const evicted = store.cleanup({ maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxRows: 5 });
    assert.equal(evicted, 5);
    const remaining = store.list({ limit: 100 }).map((r) => r.jobId);
    // Newest 5 retained: j9 down to j5.
    assert.deepEqual(remaining, ["j9", "j8", "j7", "j6", "j5"]);
    store.close();
  } finally {
    cleanup();
  }
});

test("get + list survive a close/reopen cycle (persistence)", () => {
  const { path, cleanup } = tmpDb();
  try {
    const first = openJobsStorage(path);
    first.upsert(baseRow({
      jobId: "persist-me",
      status: "running",
      progress: { doneUnits: 5 },
      startedAtMs: 1700000000000,
    }));
    first.close();

    const second = openJobsStorage(path);
    const hit = second.get("persist-me");
    assert.ok(hit);
    assert.equal(hit.status, "running");
    assert.deepEqual(hit.progress, { doneUnits: 5 });
    const list = second.list({ status: "running" });
    assert.equal(list.length, 1);
    second.close();
  } finally {
    cleanup();
  }
});

test("storing progress=null preserves null on read", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openJobsStorage(path);
    store.upsert(baseRow({ jobId: "no-progress", progress: null }));
    const hit = store.get("no-progress");
    assert.equal(hit.progress, null);
    store.close();
  } finally {
    cleanup();
  }
});
