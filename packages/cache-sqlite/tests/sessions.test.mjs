// node:test runner — node:sqlite isn't a builtin vite recognises, so
// staying on node:test keeps the cache-sqlite test surface aligned
// with the rest of the package.
//
// Run after `pnpm build`: `node --test tests/sessions.test.mjs`

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSessionsStorage } from "../dist/sessions-storage.js";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "cortex-sessions-test-"));
  const path = join(dir, "sessions.db");
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
    sessionId: `dash_${Math.random().toString(36).slice(2, 10)}`,
    workspace: "work",
    scopesJson: JSON.stringify(["admin"]),
    tokenLabel: null,
    githubLogin: null,
    githubUserId: null,
    githubAvatarUrl: null,
    githubAccessToken: null,
    createdAtMs: now,
    expiresAtMs: now + 24 * 60 * 60 * 1000,
    lastSeenAtMs: now,
    ...overrides,
  };
}

test("schema migration adds cache_sessions idempotently", () => {
  const { path, cleanup } = tmpDb();
  try {
    openSessionsStorage(path).close();
    const store = openSessionsStorage(path);
    // Reopening must not throw and must hand back null for a missing id.
    assert.equal(store.get("nope"), null);
    store.close();
  } finally {
    cleanup();
  }
});

test("upsert + get roundtrip preserves every field including github identity", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openSessionsStorage(path);
    const row = baseRow({
      sessionId: "dash_abc",
      workspace: "personal",
      scopesJson: JSON.stringify(["read", "ingest", "admin"]),
      tokenLabel: null,
      githubLogin: "octocat",
      githubUserId: 583231,
      githubAvatarUrl: "https://avatars.githubusercontent.com/u/583231",
      githubAccessToken: "ghu_abcdef",
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_000_000 + 86_400_000,
      lastSeenAtMs: 1_700_000_000_500,
    });
    store.upsert(row);
    const hit = store.get("dash_abc");
    assert.ok(hit);
    assert.equal(hit.sessionId, "dash_abc");
    assert.equal(hit.workspace, "personal");
    assert.deepEqual(JSON.parse(hit.scopesJson), ["read", "ingest", "admin"]);
    assert.equal(hit.tokenLabel, null);
    assert.equal(hit.githubLogin, "octocat");
    assert.equal(hit.githubUserId, 583231);
    assert.equal(hit.githubAvatarUrl, "https://avatars.githubusercontent.com/u/583231");
    assert.equal(hit.githubAccessToken, "ghu_abcdef");
    assert.equal(hit.createdAtMs, 1_700_000_000_000);
    assert.equal(hit.lastSeenAtMs, 1_700_000_000_500);
    store.close();
  } finally {
    cleanup();
  }
});

test("upsert with same session_id replaces the row", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openSessionsStorage(path);
    store.upsert(baseRow({ sessionId: "dash_x", lastSeenAtMs: 1_000 }));
    store.upsert(baseRow({
      sessionId: "dash_x",
      githubLogin: "matt",
      lastSeenAtMs: 2_000,
    }));
    const hit = store.get("dash_x");
    assert.equal(hit.githubLogin, "matt");
    assert.equal(hit.lastSeenAtMs, 2_000);
    // Single row, not two.
    assert.equal(store.list().length, 1);
    store.close();
  } finally {
    cleanup();
  }
});

test("evict removes the row and reports whether it existed", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openSessionsStorage(path);
    store.upsert(baseRow({ sessionId: "dash_e" }));
    assert.equal(store.evict("dash_e"), true);
    assert.equal(store.get("dash_e"), null);
    // Second evict is a no-op.
    assert.equal(store.evict("dash_e"), false);
    store.close();
  } finally {
    cleanup();
  }
});

test("cleanup drops only rows whose expires_at has passed", () => {
  const { path, cleanup } = tmpDb();
  try {
    const store = openSessionsStorage(path);
    const now = 1_800_000_000_000;
    store.upsert(baseRow({
      sessionId: "dash_old",
      expiresAtMs: now - 1,
      lastSeenAtMs: now - 1000,
    }));
    store.upsert(baseRow({
      sessionId: "dash_fresh",
      expiresAtMs: now + 60_000,
      lastSeenAtMs: now,
    }));
    const evicted = store.cleanup(now);
    assert.equal(evicted, 1);
    assert.equal(store.get("dash_old"), null);
    assert.ok(store.get("dash_fresh"));
    store.close();
  } finally {
    cleanup();
  }
});

test("get + list survive a close/reopen cycle (persistence)", () => {
  const { path, cleanup } = tmpDb();
  try {
    const first = openSessionsStorage(path);
    first.upsert(baseRow({
      sessionId: "dash_persist",
      githubLogin: "matt",
      githubAccessToken: "gho_test",
    }));
    first.close();

    const second = openSessionsStorage(path);
    const hit = second.get("dash_persist");
    assert.ok(hit);
    assert.equal(hit.githubLogin, "matt");
    assert.equal(hit.githubAccessToken, "gho_test");
    const list = second.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionId, "dash_persist");
    second.close();
  } finally {
    cleanup();
  }
});
