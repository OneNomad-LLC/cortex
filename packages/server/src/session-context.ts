import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDotEnv } from "./cli/dotenv.js";

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
  /**
   * Per-session env bag loaded from the bound workspace's .env at bind
   * time. Tools that need workspace-scoped secrets should call
   * `getSessionEnvVar(name)` instead of reading process.env directly —
   * that way two sessions bound to two workspaces don't see each
   * other's secrets. Not persisted to disk (it's reloadable from the
   * workspace's .env).
   */
  envBag?: Map<string, string>;
  /**
   * Resolved tool surface for this session based on the bearer's
   * scope claims. `undefined` means no scope token was presented —
   * the legacy opaque-bearer / gateway-secret / cookie path; the
   * session sees the full ALL_TOOLS surface (backwards compat with
   * direct API + dashboard usage). A populated set means the bearer
   * was a cscope JWT and the session is restricted to those names.
   */
  toolAllowList?: Set<string>;
}

const sessionStates = new Map<string, SessionState>();
const contextStorage = new AsyncLocalStorage<{ sessionId: string }>();

/**
 * Where session bindings get persisted across server restarts. Docker
 * deploys run the server as a long-lived container; a crash or redeploy
 * wipes in-memory state otherwise, silently unbinding every live
 * Claude session. Skip persistence entirely by setting
 * `PRZM_CORTEX_SESSION_STATE_PATH=`.
 */
function sessionStatePath(): string | undefined {
  const explicit = process.env.PRZM_CORTEX_SESSION_STATE_PATH;
  if (explicit === "") return undefined;
  if (explicit) return explicit;
  return path.join(os.homedir(), ".cortex", "sessions.json");
}

let persistTimer: NodeJS.Timeout | undefined;

/**
 * Debounce on-disk writes. A bursty series of set_session_workspace
 * calls from a client setting up multiple sessions coalesces into one
 * disk write after 500ms of quiet. Timer is reset on every schedule.
 */
function schedulePersist(): void {
  const p = sessionStatePath();
  if (!p) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistSessionStates(p).catch(() => undefined);
  }, 500);
  persistTimer.unref?.();
}

async function persistSessionStates(p: string): Promise<void> {
  const serializable = [...sessionStates.entries()].map(([id, s]) => ({
    id,
    workspace: s.workspace === undefined ? null : s.workspace,
    hadWorkspace: s.workspace !== undefined,
    firstSeenAt: s.firstSeenAt,
    lastSeenAt: s.lastSeenAt,
  }));
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify({ sessions: serializable }, null, 2), "utf8");
  await rename(tmp, p);
}

/**
 * Called once at server startup. Rehydrates sessionStates from the
 * persisted file so clients reconnecting after a restart keep their
 * workspace binding. Sessions older than `maxAgeMs` are dropped.
 */
export async function restoreSessionStates(
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<number> {
  const p = sessionStatePath();
  if (!p) return 0;
  let raw: string;
  try {
    raw = await readFile(p, "utf8");
  } catch {
    return 0;
  }
  let parsed: {
    sessions?: Array<{
      id: string;
      workspace: string | null;
      hadWorkspace?: boolean;
      firstSeenAt: number;
      lastSeenAt: number;
    }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let restored = 0;
  for (const s of parsed.sessions ?? []) {
    if (s.lastSeenAt < cutoff) continue;
    sessionStates.set(s.id, {
      workspace: s.hadWorkspace === false ? undefined : s.workspace,
      firstSeenAt: s.firstSeenAt,
      lastSeenAt: s.lastSeenAt,
      // envBag is intentionally not restored — reloaded lazily on
      // first tool call that touches the bound workspace.
    });
    restored++;
  }
  return restored;
}

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
  // lastSeenAt changes on every request — debounce covers the burst.
  schedulePersist();
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
  // Reload env bag on binding change. Keeps per-session secrets scoped
  // to the newly-bound workspace; null workspace clears the bag.
  if (typeof workspace === "string") {
    const root =
      process.env.PRZM_CORTEX_WORKSPACES_ROOT ??
      path.join(os.homedir(), ".cortex", "workspaces");
    const envPath = path.join(root, workspace, ".env");
    state.envBag = parseDotEnv(envPath);
  } else {
    delete state.envBag;
  }
  sessionStates.set(sessionId, state);
  schedulePersist();
  return state;
}

/**
 * Workspace-scoped env accessor. Reads the current session's envBag
 * first, falling back to `process.env` so tools unaware of session
 * scoping still work. Tools that handle workspace-specific secrets
 * (API keys, etc.) should prefer this over `process.env[name]`.
 */
export function getSessionEnvVar(name: string): string | undefined {
  const bag = getCurrentSessionState()?.envBag;
  const fromBag = bag?.get(name);
  if (fromBag !== undefined && fromBag !== "") return fromBag;
  return process.env[name];
}

/** Read the workspace for the current ALS-bound session. */
export function getCurrentWorkspace(): string | null | undefined {
  return getCurrentSessionState()?.workspace;
}

/**
 * Stamp the tool allow-list onto a session. Called by the transport's
 * authOk after verifying a scope-bearing JWT. `undefined` clears the
 * restriction (legacy opaque bearer or other unscoped credential).
 */
export function setSessionToolAllowList(
  sessionId: string,
  allowList: Set<string> | undefined,
): void {
  const state = sessionStates.get(sessionId);
  if (!state) {
    sessionStates.set(sessionId, {
      workspace: undefined,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      ...(allowList ? { toolAllowList: allowList } : {}),
    });
    return;
  }
  if (allowList) state.toolAllowList = allowList;
  else delete state.toolAllowList;
}

/** Tool allow-list for the current ALS-bound session. */
export function getCurrentToolAllowList(): Set<string> | undefined {
  return getCurrentSessionState()?.toolAllowList;
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
  if (removed > 0) schedulePersist();
  return removed;
}
