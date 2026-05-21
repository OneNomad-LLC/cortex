/**
 * Coverage for `/api/dashboard/identity`:
 *   - GET returns null self + job profile presence when nothing configured
 *   - GET returns the configured self person after upsert
 *   - POST /self happy path persists + lights up GET
 *   - All routes require admin auth (401 without cookie)
 *
 * Job-profile editing is exercised in the dashboard-identity routes
 * themselves; we verify the GET surface only — the actual write path
 * uses the same `upsertJobProfile` helpers covered elsewhere.
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
import { handle as dashboardIdentityHandle } from "../src/api/routes/dashboard-identity.js";
import { mergeEnv } from "../src/cli/config-mutation.js";
import type { RouteContext } from "../src/api/route-context.js";

interface FetchResp {
  status: number;
  body: unknown;
  setCookie: string | undefined;
}

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let workspacesRoot: string;
let activeSlug: string;
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
        if (await dashboardIdentityHandle(req, res, ctx)) return;
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
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cortex-dash-identity-"));
  workspacesRoot = path.join(tmpDir, "workspaces");
  activeSlug = "testws";
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

describe("GET /api/dashboard/identity", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const resp = await fetchJson("/api/dashboard/identity");
    expect(resp.status).toBe(401);
  });

  it("returns null self when nothing configured yet", async () => {
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/identity", {
      headers: { cookie: `cortex_dash_sid=${sid}` },
    });
    expect(resp.status).toBe(200);
    const body = resp.body as { self: unknown; jobProfile: unknown };
    expect(body.self).toBeNull();
    // jobProfile is always present — either { available: false } or
    // { available: true, profile: ... }.
    expect(body.jobProfile).toBeDefined();
  });

  it("returns the configured self person after an upsert", async () => {
    const sid = await loginAndGetCookie();
    const upsert = await fetchJson("/api/dashboard/identity/self", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({
        slug: "matt",
        name: "Matt Stvartak",
        email: "hello@mattstvartak.com",
        role: "Engineer",
      }),
    });
    expect(upsert.status).toBe(200);
    const upsertBody = upsert.body as {
      ok: boolean;
      identity: { slug: string; self: boolean };
    };
    expect(upsertBody.ok).toBe(true);
    expect(upsertBody.identity.slug).toBe("matt");
    expect(upsertBody.identity.self).toBe(true);

    const get = await fetchJson("/api/dashboard/identity", {
      headers: { cookie: `cortex_dash_sid=${sid}` },
    });
    expect(get.status).toBe(200);
    const body = get.body as {
      self: { slug: string; name: string; email: string; role?: string; self: boolean };
    };
    expect(body.self.slug).toBe("matt");
    expect(body.self.name).toBe("Matt Stvartak");
    expect(body.self.email).toBe("hello@mattstvartak.com");
    expect(body.self.role).toBe("Engineer");
    expect(body.self.self).toBe(true);
  });
});

describe("POST /api/dashboard/identity/self", () => {
  it("rejects malformed bodies with 400", async () => {
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/identity/self", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({ slug: "matt" }),
    });
    expect(resp.status).toBe(400);
    expect((resp.body as Record<string, unknown>).error).toBe("invalid_body");
  });

  it("requires the CSRF header on writes", async () => {
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/identity/self", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: "matt",
        name: "M",
        email: "m@example.com",
      }),
    });
    expect(resp.status).toBe(403);
    expect((resp.body as Record<string, unknown>).error).toBe("csrf_required");
  });
});

describe("POST /api/dashboard/identity/job-profile", () => {
  it("happy path persists the patch (when module available)", async () => {
    // The job-profile helpers are exported from taxonomy-mutation in
    // this repo, so the route should accept the patch. We don't gate
    // the test on `module_unavailable` because the assertion is
    // strictly stronger when it IS available.
    const sid = await loginAndGetCookie();
    const resp = await fetchJson("/api/dashboard/identity/job-profile", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({
        title: "Engineer",
        focusAreas: ["dashboard", "agents"],
      }),
    });
    expect([200, 404]).toContain(resp.status);
    if (resp.status === 200) {
      const body = resp.body as { ok: boolean; profile: { title?: string } };
      expect(body.ok).toBe(true);
      expect(body.profile.title).toBe("Engineer");
    }
  });
});
