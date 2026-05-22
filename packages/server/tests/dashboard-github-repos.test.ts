/**
 * Coverage for `/api/dashboard/github/repos/*`:
 *   - GET returns 412 when SessionState.githubAccessToken is absent
 *     (Slice A's OAuth handshake hasn't run yet)
 *   - GET aggregates pages from GitHub + merges ingested flag from yaml
 *   - POST /sync adds repos to cortex.yaml and enqueues jobs (idempotent)
 *   - POST /:owner/:name/sync single-shot
 *   - DELETE removes from yaml; ?purge=true also calls engram.delete
 *   - 401 unauth + 403 missing CSRF gating
 *
 * Tests inject githubAccessToken onto the dashboard session directly
 * via `setDashboardSession` so we don't need to stand up the OAuth
 * flow Slice A owns — the contract this test pins is "the API reads
 * `githubAccessToken` from SessionState and proxies to GitHub".
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bearerAuth,
  jsonFetch,
  startDashboardTestServer,
  type DashboardTestHarness,
} from "./dashboard-helpers.js";
import { handle as reposHandle } from "../src/api/routes/dashboard-github-repos.js";
import { handleLogin } from "../src/api/routes/dashboard-auth.js";
import {
  generateRawToken,
  hashToken,
} from "../src/auth/dashboard-token.js";
import { mergeEnv } from "../src/cli/config-mutation.js";
import { jobs } from "../src/mcp/jobs.js";
import { makeInMemoryJobsStorage } from "./fake-jobs-storage.js";
import {
  setDashboardSession,
  type SessionState,
} from "../src/session-context.js";
import type { JobsStorage } from "@onenomad/przm-cortex-cache-sqlite";
import type { EngramClient } from "../src/clients/engram.js";
import { writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";

let harness: DashboardTestHarness;
let storage: JobsStorage;
let workspaceConfigPath: string;
const ORIGINAL_ENV = { ...process.env };

/**
 * Read whichever cortex config file is "live" — the .local overlay
 * if it exists, otherwise the committed template. Mirrors the
 * resolveLocalFirst behavior the routes use so tests assert against
 * the file the writer actually touched.
 */
async function readEffectiveConfig(): Promise<{
  adapters: { github: { config: { repos: string[] } } };
}> {
  const localPath = workspaceConfigPath.replace(/\.yaml$/, ".local.yaml");
  let raw: string;
  try {
    raw = await readFile(localPath, "utf8");
  } catch {
    raw = await readFile(workspaceConfigPath, "utf8");
  }
  return parseYaml(raw) as {
    adapters: { github: { config: { repos: string[] } } };
  };
}

function fakeEngram(deleteFn?: (input: unknown) => Promise<{ deleted: number }>): EngramClient {
  return {
    async ingest() {
      return { id: "fake-mem-1" };
    },
    async search() {
      return [];
    },
    async healthCheck() {
      return { healthy: true, message: "" };
    },
    async shutdown() {
      return;
    },
    async wipeAll() {
      return { deleted: 0 };
    },
    // eslint-disable-next-line require-yield
    async *exportAll() {
      return;
    },
    ...(deleteFn ? { delete: deleteFn } : {}),
  } as EngramClient;
}

/**
 * Login as the admin token and stamp `githubAccessToken` onto the
 * resulting dashboard session. Returns a `{cookie}` headers bag the
 * test can pass into subsequent calls.
 */
async function loginWithGithubToken(
  githubAccessToken: string | null,
): Promise<{ cookie: string; sessionId: string }> {
  const resp = await fetch(`${harness.baseUrl}/api/dashboard/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: harness.rawToken }),
  });
  expect(resp.status).toBe(200);
  const setCookie = resp.headers.get("set-cookie") ?? "";
  const m = /(cortex_dash_sid=([^;]+))/.exec(setCookie);
  if (!m) throw new Error("login did not return session cookie");
  const cookie = m[1]!;
  const sessionId = m[2]!;
  // Re-stamp the session — preserves the scope flag the gate wants,
  // adds githubAccessToken on top so the route sees it.
  setDashboardSession(sessionId, {
    workspace: harness.workspaceSlug,
    scopes: ["admin"],
    tokenLabel: "default",
  });
  if (githubAccessToken !== null) {
    // The field is owned by Slice A and isn't on the typed shape yet —
    // poke it on through a cast so the route's bracket-access reads it.
    const { getSessionState } = await import("../src/session-context.js");
    const state = getSessionState(sessionId) as SessionState | undefined;
    if (!state) throw new Error("session state vanished after login");
    (state as unknown as Record<string, unknown>)["githubAccessToken"] =
      githubAccessToken;
  }
  return { cookie, sessionId };
}

const SAMPLE_REPO = {
  id: 1,
  full_name: "octo/hello-world",
  name: "hello-world",
  description: "A test repo",
  private: false,
  archived: false,
  fork: false,
  html_url: "https://github.com/octo/hello-world",
  default_branch: "main",
  language: "TypeScript",
  pushed_at: "2025-05-01T00:00:00Z",
  owner: { login: "octo" },
};

const SECOND_REPO = {
  ...SAMPLE_REPO,
  id: 2,
  full_name: "octo/repo-two",
  name: "repo-two",
  description: "Already connected",
  html_url: "https://github.com/octo/repo-two",
  language: "Go",
  pushed_at: "2025-04-15T00:00:00Z",
};

beforeEach(async () => {
  jobs._reset();
  storage = makeInMemoryJobsStorage();
  jobs.setStorage(storage);
  jobs.setDefaultWorkspace("testws");
  harness = await startDashboardTestServer([reposHandle], {
    engram: fakeEngram(),
    taxonomy: { findProject: () => undefined, findPerson: () => undefined } as never,
    memoryTypes: undefined as never,
  });
  // Seed a cortex.yaml in the harness workspace so config-path
  // helpers find it. The harness builds the workspace dir but not the
  // config — we add it here so route handlers can read/write.
  const workspaceDir = path.dirname(harness.workspaceEnvPath);
  workspaceConfigPath = path.join(workspaceDir, "config", "cortex.yaml");
  await writeFile(
    workspaceConfigPath,
    [
      "llm:",
      "  providers: {}",
      "  tasks:",
      "    default: { provider: openrouter, model: anthropic/claude-haiku-4.5 }",
      "  fallbackChain: []",
      "adapters:",
      "  github:",
      "    package: '@onenomad/przm-cortex-adapter-github'",
      "    enabled: true",
      "    config:",
      "      repos:",
      "        - octo/repo-two",
      "",
    ].join("\n"),
    "utf8",
  );
});

afterEach(async () => {
  await harness.cleanup();
  storage.close();
  jobs._reset();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("GET /api/dashboard/github/repos", () => {
  it("returns 401 without auth", async () => {
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/github/repos");
    expect(resp.status).toBe(401);
  });

  it("returns 412 when githubAccessToken is absent on the session", async () => {
    const { cookie } = await loginWithGithubToken(null);
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/github/repos", {
      headers: { cookie },
    });
    expect(resp.status).toBe(412);
    expect((resp.body as { error: string }).error).toBe("github_not_connected");
  });

  it("aggregates repos and merges ingested flag from cortex.yaml", async () => {
    // Log in BEFORE stubbing fetch — the login route uses real HTTP
    // to mint the session cookie. After that we patch globalThis.fetch
    // to intercept just GitHub API calls; everything else (the
    // route's own bookkeeping) is local function calls now.
    const { cookie } = await loginWithGithubToken("gh-test-token-123");
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.startsWith("https://api.github.com/user/repos")) {
        return new Response(JSON.stringify([SAMPLE_REPO, SECOND_REPO]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Pass through to real fetch for any test-internal HTTP calls
      // (e.g. the actual /api/dashboard/github/repos round-trip).
      return realFetch(input, init);
    });
    const resp = await jsonFetch(harness.baseUrl, "/api/dashboard/github/repos", {
      headers: { cookie },
    });
    expect(resp.status).toBe(200);
    const body = resp.body as {
      repos: Array<{ fullName: string; ingested: boolean; owner: string; defaultBranch: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(body.total).toBe(2);
    expect(body.hasMore).toBe(false);
    const octoHello = body.repos.find((r) => r.fullName === "octo/hello-world");
    const repoTwo = body.repos.find((r) => r.fullName === "octo/repo-two");
    expect(octoHello?.ingested).toBe(false);
    expect(octoHello?.owner).toBe("octo");
    expect(octoHello?.defaultBranch).toBe("main");
    expect(repoTwo?.ingested).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("POST /api/dashboard/github/repos/sync", () => {
  it("appends new repos to cortex.yaml and enqueues jobs", async () => {
    const { cookie } = await loginWithGithubToken("gh-test-token-123");
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/github/repos/sync",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cortex-dashboard": "1",
          cookie,
        },
        body: JSON.stringify({
          repos: ["octo/hello-world", "octo/repo-two", "bad-input"],
        }),
      },
    );
    expect(resp.status).toBe(200);
    const body = resp.body as {
      jobs: Array<{ repo: string; jobId: string | null; status: string }>;
    };
    const helloRow = body.jobs.find((j) => j.repo === "octo/hello-world");
    const twoRow = body.jobs.find((j) => j.repo === "octo/repo-two");
    const badRow = body.jobs.find((j) => j.repo === "bad-input");
    expect(helloRow?.status).toBe("queued");
    expect(helloRow?.jobId).toBeTruthy();
    // Already in yaml → idempotent, returns already_connected.
    expect(twoRow?.status).toBe("already_connected");
    // Slug mismatch → unauthorized sentinel.
    expect(badRow?.status).toBe("unauthorized");
    expect(badRow?.jobId).toBeNull();

    // cortex.local.yaml now lists both repos (the writer goes
    // through `ensureLocalCopy`, which copies the template into the
    // .local overlay on first touch and applies subsequent writes
    // there — same pattern as `dashboard-adapters.ts`).
    const parsed = await readEffectiveConfig();
    expect(parsed.adapters.github.config.repos.sort()).toEqual(
      ["octo/hello-world", "octo/repo-two"].sort(),
    );

    // Jobs were created in the registry with kind=github-sync.
    expect(helloRow?.jobId).toBeDefined();
    const job = jobs.get(helloRow!.jobId!);
    expect(job?.kind).toBe("github-sync");
  });

  it("requires CSRF (403 without the header)", async () => {
    const { cookie } = await loginWithGithubToken("gh-test-token-123");
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/github/repos/sync",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ repos: ["octo/x"] }),
      },
    );
    expect(resp.status).toBe(403);
  });

  it("400s when repos array is empty", async () => {
    const { cookie } = await loginWithGithubToken("gh-test-token-123");
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/github/repos/sync",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cortex-dashboard": "1",
          cookie,
        },
        body: JSON.stringify({ repos: [] }),
      },
    );
    expect(resp.status).toBe(400);
  });
});

describe("POST /api/dashboard/github/repos/:owner/:name/sync", () => {
  it("syncs a single repo and stamps it into the yaml", async () => {
    const { cookie } = await loginWithGithubToken("gh-test-token-123");
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/github/repos/octo/new-repo/sync",
      {
        method: "POST",
        headers: { cookie, "x-cortex-dashboard": "1" },
      },
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { repo: string; jobId: string; status: string };
    expect(body.repo).toBe("octo/new-repo");
    expect(body.status).toBe("queued");
    const parsed = await readEffectiveConfig();
    expect(parsed.adapters.github.config.repos).toContain("octo/new-repo");
  });
});

describe("DELETE /api/dashboard/github/repos/:owner/:name", () => {
  it("removes a repo from cortex.yaml", async () => {
    const { cookie } = await loginWithGithubToken("gh-test-token-123");
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/github/repos/octo/repo-two",
      {
        method: "DELETE",
        headers: { cookie, "x-cortex-dashboard": "1" },
      },
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { removed: boolean; memoriesPurged?: number };
    expect(body.removed).toBe(true);
    expect(body.memoriesPurged).toBeUndefined();
    const parsed = await readEffectiveConfig();
    expect(parsed.adapters.github.config.repos).not.toContain("octo/repo-two");
  });

  it("calls engram.delete when ?purge=true", async () => {
    let deleted = 0;
    // Replace the engram on the harness's RouteContext.opts at boot
    // time — the harness exposes opts on every request, so we need a
    // fresh server. Done inline.
    await harness.cleanup();
    storage.close();
    jobs._reset();
    storage = makeInMemoryJobsStorage();
    jobs.setStorage(storage);
    jobs.setDefaultWorkspace("testws");
    const purgeEngram = fakeEngram(async (input) => {
      deleted += 1;
      void input;
      return { deleted: 1 };
    });
    // Override search so the route's "find chunks with github:repo-two:" pass finds something.
    (purgeEngram as unknown as { search: () => Promise<unknown> }).search = async () => [
      { id: "chunk-1", content: "x", metadata: { source_id: "github:octo/repo-two:src/a.ts" } },
      { id: "chunk-2", content: "y", metadata: { source_id: "github:octo/other:foo.ts" } },
    ];
    harness = await startDashboardTestServer([reposHandle], {
      engram: purgeEngram,
      taxonomy: { findProject: () => undefined, findPerson: () => undefined } as never,
      memoryTypes: undefined as never,
    });
    // Re-seed config file in the new tmp workspace.
    const workspaceDir = path.dirname(harness.workspaceEnvPath);
    workspaceConfigPath = path.join(workspaceDir, "config", "cortex.yaml");
    await writeFile(
      workspaceConfigPath,
      [
        "adapters:",
        "  github:",
        "    package: '@onenomad/przm-cortex-adapter-github'",
        "    enabled: true",
        "    config:",
        "      repos:",
        "        - octo/repo-two",
        "",
      ].join("\n"),
      "utf8",
    );

    const { cookie } = await loginWithGithubToken("gh-test-token-123");
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/github/repos/octo/repo-two?purge=true",
      {
        method: "DELETE",
        headers: { cookie, "x-cortex-dashboard": "1" },
      },
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { removed: boolean; memoriesPurged: number };
    expect(body.removed).toBe(true);
    // Only the matching-prefix chunk was deleted; other source was skipped.
    expect(deleted).toBe(1);
    expect(body.memoriesPurged).toBe(1);
  });
});

describe("POST /api/dashboard/github/repos/:owner/:name/mode", () => {
  it("writes the override and surfaces the resolved mode", async () => {
    const { cookie } = await loginWithGithubToken("gh-test-token-123");
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/github/repos/octo/repo-two/mode",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cortex-dashboard": "1",
          cookie,
        },
        body: JSON.stringify({ mode: "full" }),
      },
    );
    expect(resp.status).toBe(200);
    const body = resp.body as {
      mode: string;
      modeOverride: boolean;
      changed: boolean;
    };
    expect(body.mode).toBe("full");
    expect(body.modeOverride).toBe(true);
    expect(body.changed).toBe(true);

    // YAML now carries the per-repo entry under repoModes.
    const parsed = (await readEffectiveConfig()) as unknown as {
      adapters: { github: { config: { repoModes?: Record<string, string> } } };
    };
    expect(parsed.adapters.github.config.repoModes).toEqual({
      "octo/repo-two": "full",
    });
  });

  it("null clears the override (back to adapter default)", async () => {
    const { cookie } = await loginWithGithubToken("gh-test-token-123");
    // Set first…
    await jsonFetch(harness.baseUrl, "/api/dashboard/github/repos/octo/repo-two/mode", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cortex-dashboard": "1", cookie },
      body: JSON.stringify({ mode: "both" }),
    });
    // …then clear.
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/github/repos/octo/repo-two/mode",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cortex-dashboard": "1",
          cookie,
        },
        body: JSON.stringify({ mode: null }),
      },
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { mode: string; modeOverride: boolean };
    expect(body.modeOverride).toBe(false);
    // Mode resolves to "dossier" (the fallback) since the adapter
    // doesn't have a top-level `config.mode` configured in this fixture.
    expect(body.mode).toBe("dossier");
  });

  it("400s on an invalid mode value", async () => {
    const { cookie } = await loginWithGithubToken("gh-test-token-123");
    const resp = await jsonFetch(
      harness.baseUrl,
      "/api/dashboard/github/repos/octo/repo-two/mode",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cortex-dashboard": "1",
          cookie,
        },
        body: JSON.stringify({ mode: "garbage" }),
      },
    );
    expect(resp.status).toBe(400);
  });
});
