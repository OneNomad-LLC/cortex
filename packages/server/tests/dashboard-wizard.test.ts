/**
 * Coverage for `/api/dashboard/wizard/*`:
 *   - list filters by category and returns id+kind+name
 *   - spec strips configSchema + serializes RegExp into { source, flags }
 *   - run rejects bad bodies, surfaces zod validation errors keyed by step,
 *     and writes through to cortex.local.yaml on success
 *   - every endpoint is admin-gated (401 without a session)
 *
 * Mirrors `dashboard-auth.test.ts`'s harness: spin a real `node:http`
 * server bound to a free port, exercise the route through fetch, set up
 * the workspace + dashboard token in a tmpdir per test.
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
import {
  generateRawToken,
  hashToken,
} from "../src/auth/dashboard-token.js";
import { handle as wizardHandle } from "../src/api/routes/dashboard-wizard.js";
import {
  handleLogin,
  _resetRateLimit,
} from "../src/api/routes/dashboard-auth.js";
import type { RouteContext } from "../src/api/route-context.js";
import { mergeEnv } from "../src/cli/config-mutation.js";
import { parse as parseYaml } from "yaml";

interface FetchResp {
  status: number;
  body: unknown;
  setCookie: string | undefined;
}

let tmpDir: string;
let workspaceSlug: string;
let workspaceDir: string;
let workspaceEnvPath: string;
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
        // Stub a route context that satisfies the dashboard-wizard
        // handler's read surface (`logger`, `pathname`, `url`, plus
        // `opts.reload` — passed as undefined so `tryReload` returns
        // `false` and the test doesn't try to spin a router).
        const ctx = {
          opts: {} as RouteContext["opts"],
          logger: nullLogger() as unknown as RouteContext["logger"],
          url,
          pathname: url.pathname,
          widgets: [],
          widgetsByName: new Map(),
          widgetCtx: {} as RouteContext["widgetCtx"],
        } satisfies RouteContext;
        if (await wizardHandle(req, res, ctx)) return;
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
  return {
    status: resp.status,
    body,
    setCookie: resp.headers.get("set-cookie") ?? undefined,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cortex-dash-wizard-"));
  workspaceSlug = "testws";
  const workspacesRoot = path.join(tmpDir, "workspaces");
  workspaceDir = path.join(workspacesRoot, workspaceSlug);
  await mkdir(path.join(workspaceDir, "config"), { recursive: true });
  workspaceEnvPath = path.join(workspaceDir, ".env");
  await writeFile(workspaceEnvPath, "", "utf8");
  // Seed a minimal cortex.yaml so the loader is happy when the run path
  // calls back into config-mutation. The applyWizardResult helper will
  // create cortex.local.yaml on first write.
  await writeFile(
    path.join(workspaceDir, "config", "cortex.yaml"),
    [
      "llm:",
      "  providers: {}",
      "  tasks:",
      "    default: { provider: openrouter, model: anthropic/claude-haiku-4.5 }",
      "  fallbackChain: []",
      "adapters: {}",
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

describe("GET /api/dashboard/wizard/list", () => {
  it("rejects with 401 without an admin session", async () => {
    const r = await call("/api/dashboard/wizard/list");
    expect(r.status).toBe(401);
  });

  it("returns every wizard when no filter is given", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/list", {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    const body = r.body as { modules: Array<{ id: string; kind: string }> };
    expect(body.modules.length).toBeGreaterThan(5);
    const kinds = new Set(body.modules.map((m) => m.kind));
    expect(kinds.has("adapter")).toBe(true);
    expect(kinds.has("provider")).toBe(true);
  });

  it("filters by category", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/list?category=adapter", {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    const body = r.body as { modules: Array<{ id: string; kind: string }> };
    expect(body.modules.length).toBeGreaterThan(0);
    for (const m of body.modules) expect(m.kind).toBe("adapter");
  });

  it("400s on an unknown category", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/list?category=bogus", {
      headers: { cookie },
    });
    expect(r.status).toBe(400);
  });
});

describe("GET /api/dashboard/wizard/spec/:kind/:id", () => {
  it("returns the full spec with RegExp serialized into { source, flags }", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/spec/adapter/slack", {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      id: string;
      kind: string;
      steps: Array<{ key: string; type: string; pattern?: { source: string } }>;
      secrets: Array<{ envVar: string }>;
    };
    expect(body.id).toBe("slack");
    expect(body.kind).toBe("adapter");
    const workspaceStep = body.steps.find((s) => s.key === "workspace");
    expect(workspaceStep?.pattern?.source).toBe("^[a-z0-9-]*$");
    const channels = body.steps.find((s) => s.key === "channels");
    expect(channels?.type).toBe("list");
    expect(body.secrets.find((s) => s.envVar === "SLACK_BOT_TOKEN")).toBeDefined();
  });

  it("404s on unknown id", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/spec/adapter/does-not-exist", {
      headers: { cookie },
    });
    expect(r.status).toBe(404);
  });

  it("404s when kind doesn't match the wizard's category", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/spec/provider/slack", {
      headers: { cookie },
    });
    expect(r.status).toBe(404);
  });
});

describe("POST /api/dashboard/wizard/run", () => {
  it("requires the CSRF header (403 without it)", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/run", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(403);
  });

  it("rejects unknown moduleId with 404", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/run", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({
        moduleKind: "adapter",
        moduleId: "nope",
        answers: {},
      }),
    });
    expect(r.status).toBe(404);
  });

  it("returns step-keyed validation errors on bad config", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/run", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({
        moduleKind: "adapter",
        moduleId: "slack",
        answers: {
          // historyDays must coerce to int in [1, 365]; the slack
          // wizard's preprocess pushes string → number, so "abc" lands
          // as NaN and the schema rejects it.
          historyDays: "abc",
        },
      }),
    });
    expect(r.status).toBe(400);
    const body = r.body as { ok: boolean; errors: Record<string, string> };
    expect(body.ok).toBe(false);
    // At least one error keyed off a step path the renderer can match.
    expect(Object.keys(body.errors).length).toBeGreaterThan(0);
    expect(Object.keys(body.errors)).toContain("historyDays");
  });

  it("writes through to cortex.local.yaml on a valid submission", async () => {
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/run", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({
        moduleKind: "adapter",
        moduleId: "slack",
        answers: {
          channels: ["C0123ABC"],
          historyDays: "7",
          maxThreadsPerRun: "100",
          SLACK_BOT_TOKEN: "xoxb-test",
        },
      }),
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; filesWritten: string[] };
    expect(body.ok).toBe(true);
    expect(body.filesWritten.length).toBeGreaterThan(0);
    const localPath = path.join(
      workspaceDir,
      "config",
      "cortex.local.yaml",
    );
    const raw = await readFile(localPath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const adapters = parsed.adapters as Record<string, { enabled: boolean }>;
    expect(adapters.slack?.enabled).toBe(true);

    // Secret should land in .env, never in the YAML.
    const env = await readFile(workspaceEnvPath, "utf8");
    expect(env).toContain("SLACK_BOT_TOKEN=xoxb-test");
    expect(raw).not.toContain("xoxb-test");
  });

  it("treats __REDACTED__ as a sentinel and does NOT overwrite a saved secret", async () => {
    await mergeEnv(workspaceEnvPath, { SLACK_BOT_TOKEN: "xoxb-existing" });
    const cookie = await loginAndGetCookie();
    const r = await call("/api/dashboard/wizard/run", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-cortex-dashboard": "1",
      },
      body: JSON.stringify({
        moduleKind: "adapter",
        moduleId: "slack",
        answers: {
          channels: ["C0123ABC"],
          historyDays: "7",
          maxThreadsPerRun: "100",
          SLACK_BOT_TOKEN: "__REDACTED__",
        },
      }),
    });
    expect(r.status).toBe(200);
    const env = await readFile(workspaceEnvPath, "utf8");
    expect(env).toContain("SLACK_BOT_TOKEN=xoxb-existing");
    expect(env).not.toContain("__REDACTED__");
  });
});
