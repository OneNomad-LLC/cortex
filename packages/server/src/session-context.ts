import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Per-MCP-session context.
 *
 * Cortex's MCP server serves many concurrent clients (each Claude
 * Code instance, Claude Desktop, the browser extension — all share
 * the same server process). A single "active workspace" tracked at
 * process level fails that model: Claude A in workspace onenomad and
 * Claude B in workspace elevatedigital need independent views of
 * memory, taxonomy, and adapter state.
 *
 * Solution: AsyncLocalStorage carries the session id across every
 * MCP request, and a Map<sessionId, SessionState> holds per-session
 * preferences. `transport.ts` binds the session id at the HTTP
 * boundary; every downstream tool handler reads it via
 * `getCurrentSessionId()`.
 *
 * Session id source: the `mcp-session-id` header the streamable HTTP
 * transport already maintains. When missing (initial handshake, or a
 * non-streamable client), a fresh UUID is minted and tracked for the
 * duration of that request — benign because the session state is
 * empty anyway.
 */

export interface SessionState {
  /**
   * Workspace the session is scoped to.
   *   undefined = session never picked one (fall back to the CLI-side
   *               active pointer — backwards compat for old clients).
   *   null      = user explicitly picked "no workspace" mode.
   *   string    = bound to that workspace slug.
   */
  workspace: string | null | undefined;
  /** When the session was first seen. */
  firstSeenAt: number;
  /** Last time we received a tool call on this session. */
  lastSeenAt: number;
}

const sessionStates = new Map<string, SessionState>();
const contextStorage = new AsyncLocalStorage<{ sessionId: string }>();

/**
 * Extract the MCP session id from an incoming HTTP request. Falls
 * back to a minted UUID when the header isn't present — still lets
 * tools run, just without persistent session state across requests.
 */
export function extractSessionId(headers: Record<string, unknown>): string {
  const raw = headers["mcp-session-id"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return raw[0];
  }
  return randomUUID();
}

/**
 * Run `fn` inside an ALS context bound to this session id. Called
 * from the HTTP upgrade/handleRequest wrapper in transport.ts.
 */
export function runWithSession<T>(sessionId: string, fn: () => T): T {
  touchSession(sessionId);
  return contextStorage.run({ sessionId }, fn);
}

/**
 * Persist `sessionId` as the ALS context for the remainder of this
 * async execution and all awaited continuations. For stdio transport
 * where there's one client for the whole process lifetime — we can't
 * wrap MCP tool handlers in `runWithSession` because the SDK owns the
 * read loop, so we bind once at startup.
 *
 * Don't call this from the HTTP path: it leaks context across
 * concurrent requests.
 */
export function enterSession(sessionId: string): void {
  touchSession(sessionId);
  contextStorage.enterWith({ sessionId });
}

function touchSession(sessionId: string): void {
  const existing = sessionStates.get(sessionId);
  const now = Date.now();
  if (existing) {
    existing.lastSeenAt = now;
  } else {
    sessionStates.set(sessionId, {
      workspace: undefined,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }
}

/** Current session id, or undefined when outside an ALS context. */
export function getCurrentSessionId(): string | undefined {
  return contextStorage.getStore()?.sessionId;
}

/** State for the current session, or undefined when outside a context. */
export function getCurrentSessionState(): SessionState | undefined {
  const id = getCurrentSessionId();
  if (!id) return undefined;
  return sessionStates.get(id);
}

/** Explicit lookup — used by tools that want the id directly. */
export function getSessionState(sessionId: string): SessionState | undefined {
  return sessionStates.get(sessionId);
}

/** Set the workspace for a session. `null` = "no workspace" mode. */
export function setSessionWorkspace(
  sessionId: string,
  workspace: string | null,
): SessionState {
  const state = sessionStates.get(sessionId) ?? {
    workspace: undefined,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  state.workspace = workspace;
  state.lastSeenAt = Date.now();
  sessionStates.set(sessionId, state);
  return state;
}

/** Read the workspace for the current ALS-bound session. */
export function getCurrentWorkspace(): string | null | undefined {
  return getCurrentSessionState()?.workspace;
}

/** Count of distinct sessions seen — useful for /api/status. */
export function sessionCount(): number {
  return sessionStates.size;
}

/**
 * Garbage collect sessions last seen more than `olderThanMs` ago.
 * Called periodically by the server to keep the map bounded when
 * clients come and go. Sessions are cheap but not free.
 */
export function evictStaleSessions(olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const [id, state] of sessionStates) {
    // `<=` so olderThanMs=0 truly evicts everything (used by tests
    // and by `/api/status reset`).
    if (state.lastSeenAt <= cutoff) {
      sessionStates.delete(id);
      removed += 1;
    }
  }
  return removed;
}
