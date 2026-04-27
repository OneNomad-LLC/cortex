// node:test runner — vite 5.x doesn't recognize node:sqlite as a Node
// builtin, and node:test sidesteps vite's transform pipeline entirely.
// Synapse uses node:test for the same reason; consistent across the stack.
//
// Run after `pnpm build`: `node --test tests/storage.test.mjs`

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCache } from "../dist/storage.js";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "cortex-cache-test-"));
  const path = join(dir, "cache.db");
  return {
    path,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ }
    },
  };
}

test("schema migration is idempotent", () => {
  const { path, cleanup } = tmpDb();
  try {
    openCache(path).close();
    const cache = openCache(path);
    assert.equal(cache.read("priorities", "work", "abc"), null);
    cache.close();
  } finally {
    cleanup();
  }
});

test("read returns null on miss", () => {
  const { path, cleanup } = tmpDb();
  try {
    const cache = openCache(path);
    assert.equal(cache.read("priorities", "work", "abc"), null);
    cache.close();
  } finally {
    cleanup();
  }
});

test("write + read roundtrip preserves payload + refreshedAt", () => {
  const { path, cleanup } = tmpDb();
  try {
    const cache = openCache(path);
    const refreshedAt = new Date().toISOString();
    const payload = { rows: [{ id: "x", n: 42 }], generatedAt: refreshedAt };
    cache.write("priorities", "work", "abc", payload, refreshedAt);
    const hit = cache.read("priorities", "work", "abc");
    assert.ok(hit);
    assert.equal(hit.refreshedAt, refreshedAt);
    assert.equal(hit.failureCount, 0);
    assert.equal(hit.lastError, null);
    assert.deepEqual(hit.payload, payload);
    cache.close();
  } finally {
    cleanup();
  }
});

test("workspace isolation: slug-A row not visible to slug-B query", () => {
  const { path, cleanup } = tmpDb();
  try {
    const cache = openCache(path);
    const refreshedAt = new Date().toISOString();
    cache.write("priorities", "work", "abc", { tag: "A" }, refreshedAt);
    cache.write("priorities", "side-project", "abc", { tag: "B" }, refreshedAt);
    const a = cache.read("priorities", "work", "abc");
    const b = cache.read("priorities", "side-project", "abc");
    assert.deepEqual(a.payload, { tag: "A" });
    assert.deepEqual(b.payload, { tag: "B" });
    assert.equal(cache.read("priorities", "", "abc"), null);
    cache.close();
  } finally {
    cleanup();
  }
});

test("two cache_keys in same workspace don't collide", () => {
  const { path, cleanup } = tmpDb();
  try {
    const cache = openCache(path);
    const refreshedAt = new Date().toISOString();
    cache.write("priorities", "work", "key1", { v: 1 }, refreshedAt);
    cache.write("priorities", "work", "key2", { v: 2 }, refreshedAt);
    assert.deepEqual(cache.read("priorities", "work", "key1").payload, { v: 1 });
    assert.deepEqual(cache.read("priorities", "work", "key2").payload, { v: 2 });
    cache.close();
  } finally {
    cleanup();
  }
});

test("write upserts: second write replaces payload + clears failure state", () => {
  const { path, cleanup } = tmpDb();
  try {
    const cache = openCache(path);
    const t1 = "2026-04-27T00:00:00.000Z";
    const t2 = "2026-04-27T01:00:00.000Z";
    cache.write("priorities", "work", "k", { v: 1 }, t1);
    cache.recordFailure("priorities", "work", "k", "engram timeout");
    const dirty = cache.read("priorities", "work", "k");
    assert.equal(dirty.failureCount, 1);
    assert.equal(dirty.lastError, "engram timeout");
    cache.write("priorities", "work", "k", { v: 2 }, t2);
    const clean = cache.read("priorities", "work", "k");
    assert.deepEqual(clean.payload, { v: 2 });
    assert.equal(clean.refreshedAt, t2);
    assert.equal(clean.failureCount, 0);
    assert.equal(clean.lastError, null);
    cache.close();
  } finally {
    cleanup();
  }
});

test("recordFailure on unseen key inserts a sentinel row with failure_count=1", () => {
  const { path, cleanup } = tmpDb();
  try {
    const cache = openCache(path);
    cache.recordFailure("priorities", "work", "never-cached", "boom");
    const hit = cache.read("priorities", "work", "never-cached");
    assert.ok(hit);
    assert.equal(hit.payload, null);
    assert.equal(hit.failureCount, 1);
    assert.equal(hit.lastError, "boom");
    cache.close();
  } finally {
    cleanup();
  }
});

test("recordFailure on existing row increments failure_count", () => {
  const { path, cleanup } = tmpDb();
  try {
    const cache = openCache(path);
    cache.write("priorities", "work", "k", { v: 1 }, new Date().toISOString());
    cache.recordFailure("priorities", "work", "k", "first");
    cache.recordFailure("priorities", "work", "k", "second");
    const hit = cache.read("priorities", "work", "k");
    assert.equal(hit.failureCount, 2);
    assert.equal(hit.lastError, "second");
    assert.deepEqual(hit.payload, { v: 1 });
    cache.close();
  } finally {
    cleanup();
  }
});
