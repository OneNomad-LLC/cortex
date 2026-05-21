/**
 * Phase 1 dashboard-auth coverage:
 *   - argon2id round-trip
 *   - envKeyForLabel sanitization
 *   - findTokenHashes multi-entry parsing
 *   - login (missing / wrong / right token)
 *   - login rate limit (6th attempt → 429)
 *   - whoami (no cookie → 401, with cookie → 200)
 *   - logout (clears cookie + session)
 *   - CSRF gate on mutating routes
 */

import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import {
  envKeyForLabel,
  findTokenHashes,
  generateRawToken,
  hashToken,
  verifyToken,
} from "../src/auth/dashboard-token.js";
import {
  handle as dashboardAuthHandle,
  handleLogin,
  _resetRateLimit,
} from "../src/api/routes/dashboard-auth.js";
import type { RouteContext } from "../src/api/route-context.js";
import { mergeEnv } from "../src/cli/config-mutation.js";

interface FetchResp {
  status: number;
  headers: Headers;
  body: unknown;
  setCookie: string | undefined;
}

const ORIGINAL_ENV = { ...process.env };

let tmpDir: string;
let workspaceSlug: string;
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
        // Pre-auth: login handler (mirrors server.ts wiring).
        if (await handleLogin(req, res, nullLogger())) return;

        // Build a minimal route context that satisfies the handler's
        // dependency surface (it only reads `pathname`).
        const url = new URL(req.url ?? "/", baseUrl);
        const ctx = {
          opts: {} as RouteContext["opts"],
          logger: nullLogger() as unknown as RouteContext["logger"],
          url,
          pathname: url.pathname,
          widgets: [],
          widgetsByName: new Map(),
          widgetCtx: {} as RouteContext["widgetCtx"],
        } satisfies RouteContext;

        if (await dashboardAuthHandle(req, res, ctx)) return;
        res.writeHead(404).end();
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
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
    body = await resp.json();
  } else {
    body = await resp.text();
  }
  return {
    status: resp.status,
    headers: resp.headers,
    body,
    setCookie: resp.headers.get("set-cookie") ?? undefined,
  };
}

function extractCookieValue(setCookie: string | undefined, name: string): string | undefined {
  if (!setCookie) return undefined;
  // node-fetch concatenates multiple set-cookie via comma; safe split
  // for our cookies (no embedded commas in values).
  for (const part of setCookie.split(/,(?=[^ ]+=)/)) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(part);
    if (m && m[1] !== undefined) return m[1];
  }
  return undefined;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cortex-dash-auth-"));
  workspaceSlug = "testws";
  const workspacesRoot = path.join(tmpDir, "workspaces");
  const workspaceDir = path.join(workspacesRoot, workspaceSlug);
  await mkdir(path.join(workspaceDir, "config"), { recursive: true });
  workspaceEnvPath = path.join(workspaceDir, ".env");
  await writeFile(workspaceEnvPath, "", "utf8");
  stateFile = path.join(tmpDir, "state.json");
  await writeFile(
    stateFile,
    JSON.stringify({ version: 1, activeWorkspace: workspaceSlug }),
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

describe("dashboard-token helpers", () => {
  it("argon2id round-trip — verify true for the right raw, false for the wrong one", async () => {
    const raw = generateRawToken();
    const hash = await hashToken(raw);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyToken(raw, hash)).toBe(true);
    expect(await verifyToken(`${raw}x`, hash)).toBe(false);
    // Malformed stored hash → false, not throw.
    expect(await verifyToken(raw, "not-a-hash")).toBe(false);
  });

  it("envKeyForLabel sanitizes case + non-alphanumerics", () => {
    expect(envKeyForLabel("default")).toBe(
      "PRZM_CORTEX_DASHBOARD_TOKEN_HASH_DEFAULT",
    );
    expect(envKeyForLabel("My Browser")).toBe(
      "PRZM_CORTEX_DASHBOARD_TOKEN_HASH_MY_BROWSER",
    );
    expect(envKeyForLabel("ci-runner")).toBe(
      "PRZM_CORTEX_DASHBOARD_TOKEN_HASH_CI_RUNNER",
    );
    expect(envKeyForLabel("foo.bar/baz")).toBe(
      "PRZM_CORTEX_DASHBOARD_TOKEN_HASH_FOO_BAR_BAZ",
    );
  });

  it("envKeyForLabel rejects empty / whitespace / all-punctuation labels", () => {
    expect(() => envKeyForLabel("")).toThrow();
    expect(() => envKeyForLabel("   ")).toThrow();
    expect(() => envKeyForLabel("///")).toThrow();
  });

  it("findTokenHashes parses multiple entries and ignores unrelated keys", () => {
    const env = new Map([
      ["PRZM_CORTEX_DASHBOARD_TOKEN_HASH_DEFAULT", "hash-a"],
      ["PRZM_CORTEX_DASHBOARD_TOKEN_HASH_LAPTOP", "hash-b"],
      ["UNRELATED_KEY", "x"],
      ["PRZM_CORTEX_API_AUTH_TOKEN", "y"],
      // Empty value should not produce a result.
      ["PRZM_CORTEX_DASHBOARD_TOKEN_HASH_EMPTY", ""],
    ]);
    const out = findTokenHashes(env);
    expect(out.map((t) => t.label).sort()).toEqual(["DEFAULT", "LAPTOP"]);
    expect(out.find((t) => t.label === "DEFAULT")?.hash).toBe("hash-a");
  });
});

describe("POST /api/dashboard/auth/login", () => {
  async function seedToken(label = "DEFAULT"): Promise<string> {
    const raw = generateRawToken();
    const h = await hashToken(raw);
    await mergeEnv(workspaceEnvPath, {
      [`PRZM_CORTEX_DASHBOARD_TOKEN_HASH_${label}`]: h,
    });
    return raw;
  }

  it("rejects with 400 on missing body", async () => {
    const resp = await fetchJson("/api/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(400);
  });

  it("rejects with 401 when the token does not match any hash", async () => {
    await seedToken();
    const resp = await fetchJson("/api/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "deadbeef".repeat(8) }),
    });
    expect(resp.status).toBe(401);
    expect(resp.setCookie).toBeUndefined();
  });

  it("issues a session + cookie on a matching token", async () => {
    const raw = await seedToken("LAPTOP");
    const resp = await fetchJson("/api/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: raw }),
    });
    expect(resp.status).toBe(200);
    const body = resp.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.workspace).toBe(workspaceSlug);
    expect(body.scopes).toEqual(["admin"]);
    expect(body.tokenLabel).toBe("LAPTOP");
    const cookie = extractCookieValue(resp.setCookie, "cortex_dash_sid");
    expect(cookie).toBeDefined();
    expect(cookie?.startsWith("dash_")).toBe(true);
    expect(resp.setCookie).toContain("HttpOnly");
    expect(resp.setCookie).toContain("SameSite=Strict");
  });

  it("rate-limits the 6th attempt within the window", async () => {
    await seedToken();
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetchJson("/api/dashboard/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wrong-token" }),
      });
      expect(r.status).toBe(401);
    }
    const sixth = await fetchJson("/api/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(sixth.status).toBe(429);
  });
});

describe("GET /api/dashboard/auth/whoami", () => {
  it("rejects with 401 without a cookie", async () => {
    const resp = await fetchJson("/api/dashboard/auth/whoami");
    expect(resp.status).toBe(401);
  });

  it("returns workspace + scopes + tokenLabel with a valid cookie", async () => {
    const raw = generateRawToken();
    const h = await hashToken(raw);
    await mergeEnv(workspaceEnvPath, {
      PRZM_CORTEX_DASHBOARD_TOKEN_HASH_LAPTOP: h,
    });
    const login = await fetchJson("/api/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: raw }),
    });
    expect(login.status).toBe(200);
    const sid = extractCookieValue(login.setCookie, "cortex_dash_sid");
    expect(sid).toBeDefined();
    const whoami = await fetchJson("/api/dashboard/auth/whoami", {
      headers: { cookie: `cortex_dash_sid=${sid}` },
    });
    expect(whoami.status).toBe(200);
    const body = whoami.body as Record<string, unknown>;
    expect(body.workspace).toBe(workspaceSlug);
    expect(body.scopes).toEqual(["admin"]);
    expect(body.tokenLabel).toBe("LAPTOP");
  });
});

describe("POST /api/dashboard/auth/logout", () => {
  it("clears the cookie and evicts the session", async () => {
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
    const sid = extractCookieValue(login.setCookie, "cortex_dash_sid");
    expect(sid).toBeDefined();
    const logout = await fetchJson("/api/dashboard/auth/logout", {
      method: "POST",
      headers: {
        cookie: `cortex_dash_sid=${sid}`,
        "x-cortex-dashboard": "1",
      },
    });
    expect(logout.status).toBe(200);
    expect(logout.setCookie).toContain("Max-Age=0");
    // Cookie was evicted; whoami must now 401 even with the cookie
    // still pointing at the now-dead session id.
    const after = await fetchJson("/api/dashboard/auth/whoami", {
      headers: { cookie: `cortex_dash_sid=${sid}` },
    });
    expect(after.status).toBe(401);
  });
});

describe("CSRF gate on mutating routes", () => {
  it("logout without X-Cortex-Dashboard responds 403 csrf_required", async () => {
    const resp = await fetchJson("/api/dashboard/auth/logout", {
      method: "POST",
    });
    expect(resp.status).toBe(403);
    const body = resp.body as Record<string, unknown>;
    expect(body.error).toBe("csrf_required");
  });
});
