import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openIdempotencyStore } from "../dist/idempotency.js";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "cortex-notif-idem-"));
  const path = join(dir, "notifications.db");
  return {
    path,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ }
    },
  };
}

test("idempotency: hasFired returns null on miss", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openIdempotencyStore(path);
    assert.equal(store.hasFired("morning-brief:2026-04-27"), null);
    store.close();
  } finally {
    cleanup();
  }
});

test("idempotency: recordFire then hasFired roundtrips", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openIdempotencyStore(path);
    const fireTime = "2026-04-27T08:00:00.000Z";
    store.recordFire("morning-brief:2026-04-27", fireTime, "abc123");
    assert.equal(store.hasFired("morning-brief:2026-04-27"), fireTime);
    store.close();
  } finally {
    cleanup();
  }
});

test("idempotency: second recordFire with same id is no-op (first write wins)", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openIdempotencyStore(path);
    store.recordFire("dup", "2026-04-27T08:00:00.000Z", "h1");
    store.recordFire("dup", "2026-04-27T09:00:00.000Z", "h2");
    // Original fire time preserved.
    assert.equal(store.hasFired("dup"), "2026-04-27T08:00:00.000Z");
    store.close();
  } finally {
    cleanup();
  }
});

test("idempotency: schema migration is idempotent across opens", () => {
  const { path, cleanup } = tmpDb();
  try {
    openIdempotencyStore(path).close();
    const reopened = openIdempotencyStore(path);
    // Second open should also succeed and retain prior data.
    reopened.recordFire("after-reopen", "2026-04-27T10:00:00.000Z", "h");
    assert.equal(
      reopened.hasFired("after-reopen"),
      "2026-04-27T10:00:00.000Z",
    );
    reopened.close();
  } finally {
    cleanup();
  }
});

test("idempotency: distinct ids do not collide", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openIdempotencyStore(path);
    store.recordFire("morning-brief:2026-04-27", "2026-04-27T08:00:00.000Z", "h");
    store.recordFire("morning-brief:2026-04-28", "2026-04-28T08:00:00.000Z", "h");
    assert.equal(
      store.hasFired("morning-brief:2026-04-27"),
      "2026-04-27T08:00:00.000Z",
    );
    assert.equal(
      store.hasFired("morning-brief:2026-04-28"),
      "2026-04-28T08:00:00.000Z",
    );
    store.close();
  } finally {
    cleanup();
  }
});
