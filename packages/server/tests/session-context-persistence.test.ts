/**
 * Slice A coverage — write-through persistence between sessionStates
 * (in-memory) and the SessionsStorage interface.
 *
 *   - getSessionState consults storage on cache-miss + hydrates in-memory
 *   - Restart simulation: storage retained, in-memory cleared → cookie
 *     round-trip still resolves.
 *   - evictDashboardSession drops the row from storage too.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evictDashboardSession,
  getSessionState,
  setDashboardSession,
  setGitHubSession,
  setSessionsStorage,
  type SessionsStorage,
} from "../src/session-context.js";

/**
 * Tiny in-memory implementation of SessionsStorage. The real one lives
 * in @onenomad/przm-cortex-cache-sqlite and is covered by sessions.test.mjs;
 * this fake lets us assert the wiring between session-context and the
 * interface without dragging node:sqlite into vitest's transform graph.
 */
function makeFakeStorage(): SessionsStorage & { snapshot(): unknown[] } {
  const rows = new Map<string, Parameters<SessionsStorage["upsert"]>[0]>();
  return {
    upsert(row) {
      rows.set(row.sessionId, { ...row });
    },
    get(id) {
      return rows.get(id) ?? null;
    },
    evict(id) {
      return rows.delete(id);
    },
    list() {
      return Array.from(rows.values());
    },
    cleanup(nowMs) {
      const cutoff = nowMs ?? Date.now();
      let n = 0;
      for (const [id, r] of rows) {
        if (r.expiresAtMs <= cutoff) {
          rows.delete(id);
          n += 1;
        }
      }
      return n;
    },
    close() {
      rows.clear();
    },
    snapshot() {
      return Array.from(rows.values());
    },
  };
}

let storage: ReturnType<typeof makeFakeStorage>;

beforeEach(() => {
  storage = makeFakeStorage();
  setSessionsStorage(storage);
});

afterEach(() => {
  setSessionsStorage(undefined);
});

describe("setDashboardSession + setGitHubSession write-through", () => {
  it("persists dashboard sessions to storage and reads them back on the in-memory hit path", () => {
    setDashboardSession("dash_token_a", {
      workspace: "ws-a",
      scopes: ["admin"],
      tokenLabel: "LAPTOP",
    });
    expect(storage.snapshot().length).toBe(1);

    // In-memory hit — storage is still consulted only on miss, but the
    // value should match either way.
    const got = getSessionState("dash_token_a");
    expect(got?.dashboardScopes).toEqual(["admin"]);
    expect(got?.dashboardTokenLabel).toBe("LAPTOP");
  });

  it("persists github sessions with login + token", () => {
    setGitHubSession("dash_oauth_a", {
      workspace: "ws-oauth",
      githubLogin: "matt",
      githubUserId: 42,
      githubAvatarUrl: "https://avatars/matt",
      githubAccessToken: "gho_persist",
    });
    const row = storage.get("dash_oauth_a");
    expect(row).toBeTruthy();
    expect(row?.githubLogin).toBe("matt");
    expect(row?.githubUserId).toBe(42);
    expect(row?.githubAccessToken).toBe("gho_persist");
    expect(JSON.parse(row!.scopesJson)).toEqual(["admin"]);
  });
});

describe("cold-cache rehydration (restart simulation)", () => {
  it("getSessionState returns a session that exists only in storage", () => {
    const now = Date.now();
    storage.upsert({
      sessionId: "dash_restored",
      workspace: "ws-restored",
      scopesJson: JSON.stringify(["admin"]),
      tokenLabel: null,
      githubLogin: "matt",
      githubUserId: 7,
      githubAvatarUrl: "https://avatars/m",
      githubAccessToken: "gho_after_restart",
      createdAtMs: now - 60_000,
      expiresAtMs: now + 60 * 60 * 1000,
      lastSeenAtMs: now - 60_000,
    });

    const got = getSessionState("dash_restored");
    expect(got).toBeTruthy();
    expect(got?.workspace).toBe("ws-restored");
    expect(got?.dashboardScopes).toEqual(["admin"]);
    expect(got?.githubLogin).toBe("matt");
    expect(got?.githubAccessToken).toBe("gho_after_restart");
  });

  it("treats expired rows as if absent and evicts them on read", () => {
    const past = Date.now() - 1_000;
    storage.upsert({
      sessionId: "dash_stale",
      workspace: "ws",
      scopesJson: JSON.stringify(["admin"]),
      tokenLabel: null,
      githubLogin: null,
      githubUserId: null,
      githubAvatarUrl: null,
      githubAccessToken: null,
      createdAtMs: past - 10_000,
      expiresAtMs: past,
      lastSeenAtMs: past - 10_000,
    });
    expect(getSessionState("dash_stale")).toBeUndefined();
    expect(storage.get("dash_stale")).toBeNull();
  });
});

describe("evictDashboardSession", () => {
  it("clears both in-memory and persistent state", () => {
    setDashboardSession("dash_evict_me", {
      workspace: "ws",
      scopes: ["admin"],
      tokenLabel: "X",
    });
    expect(storage.get("dash_evict_me")).toBeTruthy();
    const ok = evictDashboardSession("dash_evict_me");
    expect(ok).toBe(true);
    expect(getSessionState("dash_evict_me")).toBeUndefined();
    expect(storage.get("dash_evict_me")).toBeNull();
  });
});
