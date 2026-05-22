/**
 * Coverage for `/api/dashboard/workspaces`:
 *   - GET lists workspaces with the bound-session active marker
 *   - POST /switch on a known slug returns 200 + rebinds the session
 *   - POST /switch on an unknown slug returns 404 unknown_slug
 *   - POST /create on a new slug returns 201 with workspace info
 *   - POST /create on a dup slug returns 409 already_exists
 *   - Unauthenticated requests get 401 from the gate
 *   - Mutating requests without X-Cortex-Dashboard get 403 csrf_required
 *
 * Mirrors the test wiring used in `dashboard-auth.test.ts`: spin a
 * raw `node:http` server, run the dashboard-workspaces handler behind
 * the login handler, drive it with fetch.
 */

import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import {
  generateRawToken,
  hashToken,
} from "../src/auth/dashboard-token.js";
import {
  handle as dashboardAuthHandle,
  handleLogin,
  _resetRateLimit,
} from "../src/api/routes/dashboard-auth.js";
import { handle as dashboardWorkspacesHandle } from "../src/api/routes/dashboard-workspaces.js";
import { mergeEnv } from "../src/cli/config-mutation.js";
import type { RouteContext } from "../src/api/route-context.js";

interface FetchResp {
  status: number;
  headers: Headers;
  body: unknown;
  setCookie: string | undefined;
}

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let workspacesRoot: string;
let workspaceEnvPath: string;
let stateFile: string;
let server: Server;
let baseUrl: string;

function nullLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child(this: ReturnType<typeof nullLogger>) {
      return this;
    },
  };
}

async function startTestServer(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      try {
        if (await handleLogin(req, res, nullLogger())) return;
        const url = new URL(req.url ?? "/", baseUrl);
        const ctx: RouteContext = {
          opts: {} as RouteContext["opts"],
          logger: nullLogger() as unknown as RouteContext["logger"],
          url,
          pathname: url.pathname,
          widgets: [],
          widgetsByName: new Map(),
          widgetCtx: {} as RouteContext["widgetCtx"],
        };
        if (await dashboardWorkspacesHandle(req, res, ctx)) return;
        if (await dashboardAuthHandle(req, res, ctx)) return;
        res.writeHead(404).end();
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    })();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  const port = addr && typeof addr !== "string" ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}

async function stopTestServer(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchJson(
  pathname: string,
  init: RequestInit = {},
): Promise<FetchResp> {
  const resp = await fetch(`${baseUrl}${pathname}`, init);
  let body: unknown;
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    body = await resp.json().catch(() => undefined);
  } else {
    body = await resp.text().catch(() => undefined);
  }
  return {
    status: resp.status,
    headers: resp.headers,
    body,
    setCookie: resp.headers.get("set-cookie") ?? undefined,
  };
}

function extractCookieValue(
  setCookie: string | undefined,
  name: string,
): string | undefined {
  if (!setCookie) return undefined;
  for (const part of setCookie.split(/,(?=[^ ]+=)/)) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(part);
    if (m && m[1] !== undefined) return m[1];
  }
  return undefined;
}

async function seedWorkspace(slug: string): Promise<void> {
  const wsDir = path.join(workspacesRoot, slug);
  await mkdir(path.join(wsDir, "config"), { recursive: true });
  await writeFile(path.join(wsDir, ".env"), "", "utf8");
}

async function loginAndGetCookie(): Promise<string> {
  const raw = generateRawToken();
  const h = await hashToken(raw);
  await mergeEnv(workspaceEnvPath, {
    PRZM_CORTEX_DASHBOARD_TOKEN_HASH_DEFAULT: h,
  });
  const login = await fetchJson("/api/dashboard/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: raw }),
  });
  expect(login.status).toBe(200);
  const sid = extractCookieValue(login.setCookie, "cortex_dash_sid");
  if (!sid) throw new Error("login did not set cookie");
  return sid;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cortex-dash-ws-"));
  workspacesRoot = path.join(tmpDir, "workspaces");
  const activeSlug = "testws";
  await mkdir(path.join(workspacesRoot, activeSlug, "config"), {
    recursive: true,
  });
  workspaceEnvPath = path.join(workspacesRoot, activeSlug, ".env");
  await writeFile(workspaceEnvPath, "", "utf8");
  stateFile = path.join(tmpDir, "state.json");
  await writeFile(
    stateFile,
    JSON.stringify({ version: 1, activeWorkspace: activeSlug }),
    "utf8",
  );

  process.env.PRZM_CORTEX_WORKSPACES_ROOT = workspacesRoot;
  process.env.PRZM_CORTEX_STATE_PATH = stateFile;

  _resetRateLimit();
  await startTestServer();
});

afterEach(async () => {
  await stopTestServer();
  process.env = { ...ORIGINAL_ENV };
  await rm(tmpDir, { recursive: true, force: true });
});

describe("GET /api/dashboard/workspaces", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const resp = await fetchJson("/api/dashboard/workspaces");
    expect(resp.status).toBe(401);
  });

  it("lists workspaces with the active marker", async () => {
    await seedWorkspace("other");
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/workspaces", {
      headers: { cookie: `cortex_dash_sid=${sid}` },
    });
    expect(resp.status).toBe(200);
    const body = resp.body as { workspaces: Array<{ slug: string; isActive: boolean }> };
    const map = new Map(body.workspaces.map((w) => [w.slug, w.isActive]));
    expect(map.get("testws")).toBe(true);
    expect(map.get("other")).toBe(false);
  });
});

describe("POST /api/dashboard/workspaces/switch", () => {
  it("rebinds the session to a known slug", async () => {
    await seedWorkspace("other");
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/workspaces/switch", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({ slug: "other" }),
    });
    expect(resp.status).toBe(200);
    const body = resp.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.workspace).toBe("other");

    // Confirm the bound workspace flipped — GET /workspaces should
    // now mark "other" as active.
    const list = await fetchJson("/api/dashboard/workspaces", {
      headers: { cookie: `cortex_dash_sid=${sid}` },
    });
    const listBody = list.body as { workspaces: Array<{ slug: string; isActive: boolean }> };
    const map = new Map(listBody.workspaces.map((w) => [w.slug, w.isActive]));
    expect(map.get("other")).toBe(true);
    expect(map.get("testws")).toBe(false);
  });

  it("returns 404 unknown_slug when the workspace doesn't exist", async () => {
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/workspaces/switch", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({ slug: "ghost" }),
    });
    expect(resp.status).toBe(404);
    expect((resp.body as Record<string, unknown>).error).toBe("unknown_slug");
  });

  it("returns 403 csrf_required when the header is missing", async () => {
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/workspaces/switch", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "testws" }),
    });
    expect(resp.status).toBe(403);
    expect((resp.body as Record<string, unknown>).error).toBe("csrf_required");
  });
});

describe("POST /api/dashboard/workspaces/create", () => {
  it("creates a new workspace on a fresh slug", async () => {
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/workspaces/create", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({ slug: "freshws" }),
    });
    expect(resp.status).toBe(201);
    const body = resp.body as {
      ok: boolean;
      workspace: { slug: string; path: string };
    };
    expect(body.ok).toBe(true);
    expect(body.workspace.slug).toBe("freshws");
    expect(body.workspace.path).toContain("freshws");
  });

  it("returns 409 already_exists on a duplicate slug", async () => {
    await seedWorkspace("dupe");
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/workspaces/create", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({ slug: "dupe" }),
    });
    expect(resp.status).toBe(409);
    expect((resp.body as Record<string, unknown>).error).toBe("already_exists");
  });

  it("returns 400 invalid_slug on bad slugs", async () => {
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/workspaces/create", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({ slug: "BAD SLUG" }),
    });
    expect(resp.status).toBe(400);
    expect((resp.body as Record<string, unknown>).error).toBe("invalid_slug");
  });
});

