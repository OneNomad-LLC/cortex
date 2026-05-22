/**
 * Slice A coverage:
 *   - resolveClientId fallback (workspace override → default)
 *   - parseAllowlist + isAllowlisted (case-insensitive, comma-split)
 *   - /start happy path → pollKey + intervalMs + expiresInMs
 *   - /poll pending → status: pending
 *   - /poll authorized + allowlisted → cookie + session
 *   - /poll authorized + NOT allowlisted → 403 not_allowlisted
 *   - /poll expired → status: expired
 *   - /poll 6th call within 2s on same IP → 429
 *   - /callback → 501 web_flow_disabled
 *   - whoami after github sign-in surfaces githubLogin + githubAvatarUrl
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  isAllowlisted,
  parseAllowlist,
  resolveClientId,
} from "../src/auth/github-oauth.js";
import {
  buildHandle as buildGithubAuthHandle,
  _resetPendingGrants,
} from "../src/api/routes/dashboard-auth-github.js";
import { handle as dashboardAuthHandle } from "../src/api/routes/dashboard-auth.js";
import type { RouteContext } from "../src/api/route-context.js";

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

interface FetchResp {
  status: number;
  headers: Headers;
  body: unknown;
  setCookie: string | undefined;
}

let server: Server;
let baseUrl: string;
let mockFetch: ReturnType<typeof vi.fn>;
let envMap: Map<string, string>;
const ORIGINAL_ENV = { ...process.env };

function buildContext(url: URL): RouteContext {
  return {
    opts: {} as RouteContext["opts"],
    logger: nullLogger() as unknown as RouteContext["logger"],
    url,
    pathname: url.pathname,
    widgets: [],
    widgetsByName: new Map(),
    widgetCtx: {} as RouteContext["widgetCtx"],
  };
}

async function startTestServer(): Promise<void> {
  const githubHandle = buildGithubAuthHandle({
    fetchImpl: ((input, init) =>
      mockFetch(input, init)) as unknown as typeof fetch,
    resolveWorkspace: async () => ({
      slug: "testws",
      envPath: "/tmp/fake.env",
    }),
    envLookup: (name) => envMap.get(name),
    envParser: () => envMap,
  });
  server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", baseUrl);
        const ctx = buildContext(url);
        if (await githubHandle(req, res, ctx)) return;
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

/** Stub Response object — vitest mock returns these. */
function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  envMap = new Map();
  mockFetch = vi.fn();
  _resetPendingGrants();
  await startTestServer();
});

afterEach(async () => {
  await stopTestServer();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("resolveClientId", () => {
  it("prefers the workspace-env override when present", () => {
    const env = new Map([
      ["PRZM_CORTEX_GITHUB_OAUTH_CLIENT_ID", "Ov_workspace_123"],
    ]);
    const result = resolveClientId(env);
    expect(result.clientId).toBe("Ov_workspace_123");
    expect(result.source).toBe("workspace");
  });

  it("falls back to the bundled default when workspace env is empty", () => {
    const result = resolveClientId(new Map());
    expect(result.source).toBe("default");
    expect(result.clientId.length).toBeGreaterThan(0);
  });
});

describe("parseAllowlist + isAllowlisted", () => {
  it("parses comma-separated entries and trims whitespace", () => {
    const list = parseAllowlist(" Matt , octocat,  ");
    expect(list.size).toBe(2);
    expect(isAllowlisted(list, "MATT")).toBe(true);
    expect(isAllowlisted(list, "octocat")).toBe(true);
    expect(isAllowlisted(list, "stranger")).toBe(false);
  });

  it("treats missing / empty env as fail-closed (nobody allowlisted)", () => {
    expect(parseAllowlist(undefined).size).toBe(0);
    expect(parseAllowlist("").size).toBe(0);
    expect(isAllowlisted(parseAllowlist(""), "anyone")).toBe(false);
  });
});

describe("POST /api/dashboard/auth/github/start", () => {
  it("returns userCode + verificationUri + pollKey", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        device_code: "device-aaa",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );
    const resp = await fetchJson("/api/dashboard/auth/github/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(200);
    const body = resp.body as Record<string, unknown>;
    expect(body.userCode).toBe("ABCD-1234");
    expect(body.verificationUri).toBe("https://github.com/login/device");
    expect(typeof body.pollKey).toBe("string");
    expect(body.intervalMs).toBe(5_000);
    expect(body.expiresInMs).toBe(900_000);
  });
});

describe("POST /api/dashboard/auth/github/poll", () => {
  async function start(): Promise<string> {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        device_code: "device-poll",
        user_code: "WXYZ-9999",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );
    const startResp = await fetchJson("/api/dashboard/auth/github/start", {
      method: "POST",
      body: "{}",
    });
    return (startResp.body as { pollKey: string }).pollKey;
  }

  it("returns pending while github reports authorization_pending", async () => {
    const pollKey = await start();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: "authorization_pending" }),
    );
    const resp = await fetchJson("/api/dashboard/auth/github/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollKey }),
    });
    expect(resp.status).toBe(200);
    expect((resp.body as { status: string }).status).toBe("pending");
  });

  it("returns expired when the poll key is unknown", async () => {
    const resp = await fetchJson("/api/dashboard/auth/github/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollKey: "nope" }),
    });
    expect(resp.status).toBe(410);
    expect((resp.body as { status: string }).status).toBe("expired");
  });

  it("issues a cookie + session when the user is allowlisted", async () => {
    envMap.set("PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST", "matt, octocat");
    const pollKey = await start();
    // 1. token endpoint → access_token
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: "gho_test_token",
        scope: "repo,read:user",
        token_type: "bearer",
      }),
    );
    // 2. /user
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        login: "matt",
        id: 1234,
        email: "matt@example.com",
        name: "Matt",
        avatar_url: "https://avatars.example/matt",
      }),
    );
    const resp = await fetchJson("/api/dashboard/auth/github/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollKey }),
    });
    expect(resp.status).toBe(200);
    const body = resp.body as Record<string, unknown>;
    expect(body.status).toBe("authorized");
    expect(body.login).toBe("matt");
    expect(body.workspace).toBe("testws");
    expect(body.scopes).toEqual(["admin"]);
    const cookie = extractCookieValue(resp.setCookie, "cortex_dash_sid");
    expect(cookie).toBeDefined();
    expect(cookie?.startsWith("dash_")).toBe(true);

    // whoami round-trip — surfaces github identity
    const whoami = await fetchJson("/api/dashboard/auth/whoami", {
      headers: { cookie: `cortex_dash_sid=${cookie}` },
    });
    expect(whoami.status).toBe(200);
    const wb = whoami.body as Record<string, unknown>;
    expect(wb.githubLogin).toBe("matt");
    expect(wb.githubAvatarUrl).toBe("https://avatars.example/matt");
    expect(wb.scopes).toEqual(["admin"]);
  });

  it("rejects with 403 not_allowlisted when login is missing from the allowlist", async () => {
    envMap.set("PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST", "only-matt");
    const pollKey = await start();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ access_token: "gho_stranger", scope: "repo" }),
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        login: "stranger",
        id: 9999,
        email: null,
        name: null,
        avatar_url: null,
      }),
    );
    const resp = await fetchJson("/api/dashboard/auth/github/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollKey }),
    });
    expect(resp.status).toBe(403);
    const body = resp.body as Record<string, unknown>;
    expect(body.status).toBe("not_allowlisted");
    expect(body.login).toBe("stranger");
    expect(resp.setCookie).toBeUndefined();
  });

  it("returns expired when github reports expired_token", async () => {
    const pollKey = await start();
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "expired_token" }));
    const resp = await fetchJson("/api/dashboard/auth/github/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollKey }),
    });
    expect(resp.status).toBe(200);
    expect((resp.body as { status: string }).status).toBe("expired");
    // Replay the same pollKey → server should have dropped the stash.
    const again = await fetchJson("/api/dashboard/auth/github/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollKey }),
    });
    expect(again.status).toBe(410);
  });

  it("rate-limits to a 5-call burst per 2s window per IP", async () => {
    const pollKey = await start();
    // First 5 polls all hit github (mock pending each time).
    for (let i = 0; i < 5; i++) {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "authorization_pending" }),
      );
      // eslint-disable-next-line no-await-in-loop
      const r = await fetchJson("/api/dashboard/auth/github/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pollKey }),
      });
      expect(r.status).toBe(200);
    }
    const sixth = await fetchJson("/api/dashboard/auth/github/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollKey }),
    });
    expect(sixth.status).toBe(429);
    // After the 2s window the limit resets — sanity check that we
    // don't permanently lock the IP out.
    await delay(2_100);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: "authorization_pending" }),
    );
    const seventh = await fetchJson("/api/dashboard/auth/github/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollKey }),
    });
    expect(seventh.status).toBe(200);
  });
});

describe("GET /api/dashboard/auth/github/callback", () => {
  it("returns 501 web_flow_disabled with a clear setup hint", async () => {
    const resp = await fetchJson("/api/dashboard/auth/github/callback?code=x");
    expect(resp.status).toBe(501);
    const body = resp.body as Record<string, unknown>;
    expect(body.error).toBe("web_flow_disabled");
    expect(typeof body.message).toBe("string");
    expect(body.message).toContain("PRZM_CORTEX_GITHUB_OAUTH_CLIENT_ID");
  });
});
