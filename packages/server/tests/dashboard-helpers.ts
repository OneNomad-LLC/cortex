/**
 * Shared bootstrap for the /api/dashboard/* route tests.
 *
 * Each test gets a tmpdir-rooted workspace + state.json so the
 * `getActiveWorkspace()` plumbing inside the auth gate (and any tool
 * the route forwards into) resolves to a deterministic slug instead
 * of whatever the developer's machine happens to have active. The
 * helper also seeds a dashboard token in the workspace .env so login
 * actually succeeds — exposing that raw token to the test so it can
 * authenticate subsequent requests via either `Authorization: Bearer`
 * or `Cookie: cortex_dash_sid=…`.
 */

import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { handleLogin } from "../src/api/routes/dashboard-auth.js";
import { _resetRateLimit } from "../src/api/routes/dashboard-auth.js";
import { generateRawToken, hashToken } from "../src/auth/dashboard-token.js";
import { mergeEnv } from "../src/cli/config-mutation.js";
import type { RouteContext } from "../src/api/route-context.js";
import type { RouteHandler } from "../src/api/route-context.js";

export function nullLogger(): RouteContext["logger"] {
  const log: RouteContext["logger"] = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  } as RouteContext["logger"];
  return log;
}

export interface DashboardTestHarness {
  baseUrl: string;
  workspaceSlug: string;
  workspaceEnvPath: string;
  rawToken: string;
  cleanup: () => Promise<void>;
}

export async function startDashboardTestServer(
  routes: RouteHandler[],
  opts: Partial<RouteContext["opts"]> = {},
): Promise<DashboardTestHarness> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cortex-dash-test-"));
  const workspaceSlug = "testws";
  const workspacesRoot = path.join(tmpDir, "workspaces");
  const workspaceDir = path.join(workspacesRoot, workspaceSlug);
  await mkdir(path.join(workspaceDir, "config"), { recursive: true });
  const workspaceEnvPath = path.join(workspaceDir, ".env");
  await writeFile(workspaceEnvPath, "", "utf8");
  const stateFile = path.join(tmpDir, "state.json");
  await writeFile(
    stateFile,
    JSON.stringify({ version: 1, activeWorkspace: workspaceSlug }),
    "utf8",
  );
  // Override before bringing the server up so `getActiveWorkspace()`
  // resolves to our fixture, not the developer's `~/.cortex/state.json`.
  process.env.PRZM_CORTEX_WORKSPACES_ROOT = workspacesRoot;
  process.env.PRZM_CORTEX_STATE_PATH = stateFile;
  // Point the SQLite shadow at the tmpdir too so per-test isolation
  // works (every test gets its own jobs.db).
  process.env.PRZM_CORTEX_DASHBOARD_CACHE_PATH = path.join(tmpDir, "dashboard-cache.db");

  const rawToken = generateRawToken();
  const tokenHash = await hashToken(rawToken);
  await mergeEnv(workspaceEnvPath, {
    PRZM_CORTEX_DASHBOARD_TOKEN_HASH_DEFAULT: tokenHash,
  });

  _resetRateLimit();

  let baseUrl = "";

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        // Login handler bypasses the gate. Mirrors the prod wiring.
        if (await handleLogin(req, res, nullLogger())) return;
        const url = new URL(req.url ?? "/", baseUrl || "http://localhost");
        const ctx: RouteContext = {
          opts: opts as RouteContext["opts"],
          logger: nullLogger(),
          url,
          pathname: url.pathname,
          widgets: [],
          widgetsByName: new Map(),
          widgetCtx: {} as RouteContext["widgetCtx"],
        };
        for (const handler of routes) {
          // eslint-disable-next-line no-await-in-loop
          if (await handler(req, res, ctx)) return;
        }
        res.writeHead(404, { "content-type": "application/json" }).end(
          JSON.stringify({ error: "not_found" }),
        );
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = addr && typeof addr !== "string" ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    workspaceSlug,
    workspaceEnvPath,
    rawToken,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.PRZM_CORTEX_WORKSPACES_ROOT;
      delete process.env.PRZM_CORTEX_STATE_PATH;
      delete process.env.PRZM_CORTEX_DASHBOARD_CACHE_PATH;
      try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* nothing */ }
    },
  };
}

export interface FetchJson {
  status: number;
  body: unknown;
  setCookie?: string;
}

export async function jsonFetch(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
): Promise<FetchJson> {
  const resp = await fetch(`${baseUrl}${pathname}`, init);
  let body: unknown;
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    body = await resp.json();
  } else {
    body = await resp.text();
  }
  const setCookie = resp.headers.get("set-cookie") ?? undefined;
  return {
    status: resp.status,
    body,
    ...(setCookie ? { setCookie } : {}),
  };
}

/**
 * Build the `Authorization: Bearer …` header for fixture token-auth.
 * Most route tests use the bearer path because it sidesteps the
 * cookie round-trip and works with a single header on every request.
 */
export function bearerAuth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
