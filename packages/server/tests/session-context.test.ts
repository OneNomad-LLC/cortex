import { beforeEach, describe, expect, it } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  enterSession,
  evictStaleSessions,
  extractSessionId,
  getCurrentSessionId,
  getCurrentSessionState,
  getCurrentWorkspace,
  getSessionState,
  runWithSession,
  sessionCount,
  setSessionWorkspace,
} from "../src/session-context.js";

// The session state Map is process-global. Every test runs
// `evictStaleSessions(0)` first to drop everything so test order
// doesn't leak state.

beforeEach(() => {
  evictStaleSessions(0);
});

describe("extractSessionId", () => {
  it("returns the mcp-session-id header when present", () => {
    const id = extractSessionId({ "mcp-session-id": "abc-123" });
    expect(id).toBe("abc-123");
  });

  it("picks the first value when the header is an array", () => {
    const id = extractSessionId({ "mcp-session-id": ["first", "second"] });
    expect(id).toBe("first");
  });

  it("mints a fresh UUID when the header is missing", () => {
    const id = extractSessionId({});
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("mints when the header is an empty string", () => {
    const id = extractSessionId({ "mcp-session-id": "" });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe("runWithSession + get helpers", () => {
  it("exposes the session id from inside the callback", () => {
    runWithSession("s1", () => {
      expect(getCurrentSessionId()).toBe("s1");
    });
  });

  it("returns undefined outside any runWithSession frame", () => {
    expect(getCurrentSessionId()).toBeUndefined();
    expect(getCurrentSessionState()).toBeUndefined();
    expect(getCurrentWorkspace()).toBeUndefined();
  });

  it("creates state on first run and updates lastSeenAt on subsequent runs", () => {
    runWithSession("s1", () => {
      const state = getCurrentSessionState();
      expect(state).toBeDefined();
      // New sessions start with workspace = undefined ("never picked").
      // null is reserved for "user explicitly picked no workspace".
      expect(state?.workspace).toBeUndefined();
    });
    const first = getSessionState("s1")!;
    const firstSeen = first.lastSeenAt;
    runWithSession("s1", () => {
      const state = getCurrentSessionState();
      expect(state?.lastSeenAt).toBeGreaterThanOrEqual(firstSeen);
    });
  });

  it("isolates sessions", () => {
    runWithSession("a", () => setSessionWorkspace("a", "onenomad"));
    runWithSession("b", () => setSessionWorkspace("b", "elevatedigital"));
    runWithSession("a", () => {
      expect(getCurrentWorkspace()).toBe("onenomad");
    });
    runWithSession("b", () => {
      expect(getCurrentWorkspace()).toBe("elevatedigital");
    });
  });

  it("honors explicit null workspace (no-workspace mode)", () => {
    runWithSession("s", () => setSessionWorkspace("s", null));
    runWithSession("s", () => {
      expect(getCurrentWorkspace()).toBeNull();
    });
  });
});

describe("enterSession (stdio transport path)", () => {
  // `enterSession` uses ALS.enterWith which is sticky for the current
  // async execution. To keep tests hermetic we run each call inside an
  // outer ALS.run so the binding evaporates at the end of the test.
  const outerAls = new AsyncLocalStorage<unknown>();

  it("binds a session id that survives awaited continuations", async () => {
    await outerAls.run({}, async () => {
      enterSession("stdio-one");
      // Another async hop — context must persist.
      await new Promise((r) => setTimeout(r, 1));
      expect(getCurrentSessionId()).toBe("stdio-one");
    });
  });

  it("creates state for the entered session and honors workspace writes", async () => {
    await outerAls.run({}, async () => {
      enterSession("stdio-two");
      setSessionWorkspace("stdio-two", "onenomad");
      await Promise.resolve();
      expect(getCurrentWorkspace()).toBe("onenomad");
      expect(getCurrentSessionState()?.workspace).toBe("onenomad");
    });
  });
});

describe("evictStaleSessions", () => {
  it("removes sessions last seen before the cutoff", () => {
    runWithSession("old", () => undefined);
    runWithSession("new", () => undefined);
    // Backdate `old` by mutating the map directly.
    const old = getSessionState("old")!;
    old.lastSeenAt = Date.now() - 10_000;

    const removed = evictStaleSessions(5_000);
    expect(removed).toBe(1);
    expect(getSessionState("old")).toBeUndefined();
    expect(getSessionState("new")).toBeDefined();
  });

  it("returns zero when nothing is stale", () => {
    runWithSession("fresh", () => undefined);
    const removed = evictStaleSessions(60_000);
    expect(removed).toBe(0);
    expect(sessionCount()).toBe(1);
  });

  it("evicts everything when cutoff is 0", () => {
    runWithSession("a", () => undefined);
    runWithSession("b", () => undefined);
    const removed = evictStaleSessions(0);
    expect(removed).toBe(2);
    expect(sessionCount()).toBe(0);
  });
});
