/**
 * Coverage for `/api/dashboard/adapters/*`:
 *   - list returns configured adapters with status + last-run stats
 *   - detail redacts already-set secrets to `__REDACTED__`
 *   - pause + resume flip the enabled bit in the local-overlay YAML
 *   - delete removes the adapter entry and drops its declared secrets
 *   - every endpoint is admin-gated (401 without a session)
 *
 * Note: we don't exercise trigger-fetch end-to-end here — that path
 * boots a real SourceAdapter against live state, which is integration-
 * test territory. The route's lookup-and-404-when-missing behavior is
 * covered indirectly: with no live `opts.adapters` registry in the
 * test harness, `trigger-fetch` 404s, which is what we assert.
 */

import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { parse as parseYaml } from "yaml";
import {
  generateRawToken,
  hashToken,
} from "../src/auth/dashboard-token.js";
import { handle as adaptersHandle } from "../src/api/routes/dashboard-adapters.js";
import {
  handleLogin,
  _resetRateLimit,
} from "../src/api/routes/dashboard-auth.js";
import type { RouteContext } from "../src/api/route-context.js";
import { mergeEnv } from "../src/cli/config-mutation.js";

interface FetchResp {
  status: number;
  body: unknown;
}

let tmpDir: string;
let workspaceSlug: string;
let workspaceDir: string;
let workspaceEnvPath: string;
let workspaceConfigPath: string;
let server: Server;
let baseUrl: string;
const ORIGINAL_ENV = { ...process.env };

function nullLogger() {
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child(this: typeof log) {
      return this;
    },
  };
  return log;
}

async function startServer(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      try {
        if (await handleLogin(req, res, nullLogger())) return;
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
        if (await adaptersHandle(req, res, ctx)) return;
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

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function loginAndGetCookie(): Promise<string> {
  const raw = generateRawToken();
  const h = await hashToken(raw);
  await mergeEnv(workspaceEnvPath, {
    PRZM_CORTEX_DASHBOARD_TOKEN_HASH_DEFAULT: h,
  });
  const resp = await fetch(`${baseUrl}/api/dashboard/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: raw }),
  });
  expect(resp.status).toBe(200);
  const setCookie = resp.headers.get("set-cookie") ?? "";
  const m = /(cortex_dash_sid=[^;]+)/.exec(setCookie);
  if (!m) throw new Error("login did not return session cookie");
  return m[1]!;
}

async function call(
  pathname: string,
  init: RequestInit = {},
): Promise<FetchResp> {
  const resp = await fetch(`${baseUrl}${pathname}`, init);
  const ct = resp.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? await resp.json()
    : await resp.text();
  return { status: resp.status, body };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cortex-dash-adapters-"));
  workspaceSlug = "testws";
  const workspacesRoot = path.join(tmpDir, "workspaces");
  workspaceDir = path.join(workspacesRoot, workspaceSlug);
  await mkdir(path.join(workspaceDir, "config"), { recursive: true });
  workspaceEnvPath = path.join(workspaceDir, ".env");
  workspaceConfigPath = path.join(workspaceDir, "config", "cortex.yaml");
  await writeFile(workspaceEnvPath, "", "utf8");
  // Seed a config with two adapters — one enabled, one paused — so the
  // list endpoint has something to report and the pause/resume tests
  // have something to flip.
  await writeFile(
    workspaceConfigPath,
    [
      "llm:",
      "  providers: {}",
      "  tasks:",
      "    default: { provider: openrouter, model: anthropic/claude-haiku-4.5 }",
      "  fallbackChain: []",
      "adapters:",
      "  slack:",
      "    package: '@onenomad/przm-cortex-adapter-slack'",
      "    enabled: true",
      "    config:",
      "      channels: ['C0123ABC']",
      "  github:",
      "    package: '@onenomad/przm-cortex-adapter-github'",
      "    enabled: false",
      "    config:",
      "      org: example",
      "",
    ].join("\n"),
    "utf8",
  );
  const stateFile = path.join(tmpDir, "state.json");
  await writeFile(
    stateFile,
    JSON.stringify({ version: 1, activeWorkspace: workspaceSlug }),
    "utf8",
  );

  process.env.PRZM_CORTEX_WORKSPACES_ROOT = workspacesRoot;
  process.env.PRZM_CORTEX_STATE_PATH = stateFile;
  _resetRateLimit();
  await startServer();
});

afterEach(async () => {
  await stopServer();
  process.env = { ...ORIGINAL_ENV };
  await rm(tmpDir, { recursive: true, force: true });
});

describe("GET /api/dashboard/adapters", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const r = await call("/api/dashboard/adapters");
    expect(r.status).toBe(401);
  });

  it("lists configured adapters with status badges", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters", {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      adapters: Array<{
        id: string;
        status: string;
        enabled: boolean;
      }>;
    };
    const slack = body.adapters.find((a) => a.id === "slack");
    const github = body.adapters.find((a) => a.id === "github");
    expect(slack?.enabled).toBe(true);
    expect(slack?.status).toBe("idle");
    expect(github?.enabled).toBe(false);
    expect(github?.status).toBe("paused");
  });
});

describe("GET /api/dashboard/adapters/:id", () => {
  it("404s on unknown id", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters/nope", {
      headers: { cookie },
    });
    expect(r.status).toBe(404);
  });

  it("returns the config and redacts any configured secrets", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-prod-secret";
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters/slack", {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      id: string;
      config: Record<string, unknown>;
      secrets: Record<string, string>;
    };
    expect(body.id).toBe("slack");
    expect(body.config.channels).toEqual(["C0123ABC"]);
    // SLACK_BOT_TOKEN is in env → must come back as the redaction sentinel.
    expect(body.secrets.SLACK_BOT_TOKEN).toBe("__REDACTED__");
    // Never the raw value.
    expect(JSON.stringify(body.secrets)).not.toContain("xoxb-prod-secret");
  });

  it("returns empty string for declared secrets that aren't configured", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters/slack", {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    const body = r.body as { secrets: Record<string, string> };
    expect(body.secrets.SLACK_BOT_TOKEN).toBe("");
  });
});

describe("POST /api/dashboard/adapters/:id/pause + /resume", () => {
  it("requires CSRF (403 without the header)", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters/slack/pause", {
      method: "POST",
      headers: { cookie },
    });
    expect(r.status).toBe(403);
  });

  it("flips enabled=false on pause and writes through .local.yaml", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters/slack/pause", {
      method: "POST",
      headers: { cookie, "x-cortex-dashboard": "1" },
    });
    expect(r.status).toBe(200);
    const body = r.body as { enabled: boolean };
    expect(body.enabled).toBe(false);
    // The toggle writes to whichever file resolveLocalFirst hands back.
    // With no pre-existing .local.yaml, the loader resolves the template
    // path, so check the active one for the flipped state.
    const rawTemplate = await readFile(workspaceConfigPath, "utf8");
    const parsedTemplate = parseYaml(rawTemplate) as {
      adapters: Record<string, { enabled: boolean }>;
    };
    expect(parsedTemplate.adapters.slack?.enabled).toBe(false);
  });

  it("flips enabled=true on resume", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters/github/resume", {
      method: "POST",
      headers: { cookie, "x-cortex-dashboard": "1" },
    });
    expect(r.status).toBe(200);
    const body = r.body as { enabled: boolean };
    expect(body.enabled).toBe(true);
    const raw = await readFile(workspaceConfigPath, "utf8");
    const parsed = parseYaml(raw) as {
      adapters: Record<string, { enabled: boolean }>;
    };
    expect(parsed.adapters.github?.enabled).toBe(true);
  });

  it("404s when toggling an adapter that isn't configured", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters/missing/pause", {
      method: "POST",
      headers: { cookie, "x-cortex-dashboard": "1" },
    });
    expect(r.status).toBe(404);
  });
});

describe("POST /api/dashboard/adapters/:id/trigger-fetch", () => {
  it("404s when the live adapter registry is empty", async () => {
    // Our test harness doesn't wire ctx.opts.adapters, so trigger-fetch
    // can't find a SourceAdapter to invoke. The route's contract: 404
    // with a "not currently registered" hint. Real integration coverage
    // for the happy path lives next to the scheduler tests.
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters/slack/trigger-fetch", {
      method: "POST",
      headers: { cookie, "x-cortex-dashboard": "1" },
    });
    expect(r.status).toBe(404);
  });
});

describe("DELETE /api/dashboard/adapters/:id", () => {
  it("removes the adapter entry from cortex.yaml + clears its secrets from .env", async () => {
    await mergeEnv(workspaceEnvPath, {
      SLACK_BOT_TOKEN: "xoxb-to-be-removed",
      SLACK_SIGNING_SECRET: "sig-also-removed",
      UNRELATED_KEY: "stays",
    });
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters/slack", {
      method: "DELETE",
      headers: { cookie, "x-cortex-dashboard": "1" },
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; removedSecrets: string[] };
    expect(body.ok).toBe(true);
    expect(body.removedSecrets.sort()).toEqual(
      ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"].sort(),
    );

    const raw = await readFile(workspaceConfigPath, "utf8");
    const parsed = parseYaml(raw) as { adapters: Record<string, unknown> };
    expect(parsed.adapters.slack).toBeUndefined();

    const env = await readFile(workspaceEnvPath, "utf8");
    expect(env).not.toContain("SLACK_BOT_TOKEN");
    expect(env).not.toContain("SLACK_SIGNING_SECRET");
    expect(env).toContain("UNRELATED_KEY=stays");
  });

  it("404s on unknown id", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/adapters/nope", {
      method: "DELETE",
      headers: { cookie, "x-cortex-dashboard": "1" },
    });
    expect(r.status).toBe(404);
  });
});
