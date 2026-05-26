/**
 * Coverage for the `cortex_github_ingest_repo` MCP tool:
 *   - parseRepoIdentifier accepts owner/name + 2 URL forms; rejects malformed
 *   - Already-listed repo → action='already_ingested' (no GitHub call)
 *   - 200 from GitHub → action='ingesting' + jobId + cortex.yaml updated
 *   - 404 from GitHub → action='not_accessible'
 *   - Missing token (file + env) → action='github_not_configured'
 *
 * GitHub fetch is mocked. The tool's "actually run the sync" path
 * lives in ingest_repo's own tests — here we just verify the wrapper
 * dispatches to the registry.
 */

import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { cortexGithubIngestRepo } from "../src/mcp/tools/cortex-github-ingest-repo.js";
import { parseRepoIdentifier } from "../src/api/github-repo-config.js";
import { jobs } from "../src/mcp/jobs.js";
import { makeInMemoryJobsStorage } from "./fake-jobs-storage.js";
import type { JobsStorage } from "@onenomad/przm-cortex-cache-sqlite";
import type { EngramClient } from "../src/clients/engram.js";
import type { ToolContext } from "../src/mcp/tool.js";

const ORIGINAL_ENV = { ...process.env };
let tmpDir: string;
let workspaceConfigPath: string;
let storage: JobsStorage;

function nullLogger(): ToolContext["logger"] {
  const log: ToolContext["logger"] = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  } as ToolContext["logger"];
  return log;
}

function fakeEngram(): EngramClient {
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
  } as EngramClient;
}

function makeCtx(): ToolContext {
  return {
    taxonomy: { findProject: () => undefined, findPerson: () => undefined } as never,
    memoryTypes: undefined as never,
    logger: nullLogger(),
    engram: fakeEngram(),
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cortex-mcp-ingest-"));
  const workspaceDir = path.join(tmpDir, "workspaces", "testws");
  await mkdir(path.join(workspaceDir, "config"), { recursive: true });
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
      "        - octo/already-here",
      "",
    ].join("\n"),
    "utf8",
  );
  const stateFile = path.join(tmpDir, "state.json");
  await writeFile(
    stateFile,
    JSON.stringify({ version: 1, activeWorkspace: "testws" }),
    "utf8",
  );
  process.env.PRZM_CORTEX_WORKSPACES_ROOT = path.join(tmpDir, "workspaces");
  process.env.PRZM_CORTEX_STATE_PATH = stateFile;
  // Avoid the test machine's real ~/.cortex/github-token.json
  // leaking in via tryReadGithubToken — point the resolver at a
  // non-existent path so file-resolution returns undefined.
  process.env.PRZM_CORTEX_GITHUB_TOKEN_PATH = path.join(tmpDir, "github-token.json");
  delete process.env.GITHUB_TOKEN;

  jobs._reset();
  storage = makeInMemoryJobsStorage();
  jobs.setStorage(storage);
  jobs.setDefaultWorkspace("testws");
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  storage.close();
  jobs._reset();
  try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("parseRepoIdentifier", () => {
  it("accepts owner/name slug", () => {
    expect(parseRepoIdentifier("octo/hello")).toEqual({ owner: "octo", name: "hello" });
  });
  it("accepts https URL with .git suffix", () => {
    expect(parseRepoIdentifier("https://github.com/octo/hello.git")).toEqual({
      owner: "octo",
      name: "hello",
    });
  });
  it("accepts https URL without .git suffix", () => {
    expect(parseRepoIdentifier("https://github.com/octo/hello")).toEqual({
      owner: "octo",
      name: "hello",
    });
  });
  it("accepts git@ SSH URL", () => {
    expect(parseRepoIdentifier("git@github.com:octo/hello.git")).toEqual({
      owner: "octo",
      name: "hello",
    });
  });
  it("rejects malformed input", () => {
    expect(parseRepoIdentifier("")).toBeNull();
    expect(parseRepoIdentifier("just-a-name")).toBeNull();
    expect(parseRepoIdentifier("too/many/parts")).toBeNull();
    expect(parseRepoIdentifier("https://example.com/octo/hello")).toBeNull();
    expect(parseRepoIdentifier("https://github.com/octo")).toBeNull();
  });
});

describe("cortex_github_ingest_repo", () => {
  it("returns invalid_repo on garbage input", async () => {
    process.env.GITHUB_TOKEN = "ghp_fake";
    const out = await cortexGithubIngestRepo.handler({ repo: "totally bogus" }, makeCtx());
    expect(out.action).toBe("invalid_repo");
  });

  it("returns already_ingested when the repo is in cortex.yaml", async () => {
    process.env.GITHUB_TOKEN = "ghp_fake";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await cortexGithubIngestRepo.handler(
      { repo: "octo/already-here" },
      makeCtx(),
    );
    expect(out.action).toBe("already_ingested");
    expect(out.repo).toBe("octo/already-here");
    // Fast path — we never called GitHub.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns github_not_configured when neither token file nor env has a token", async () => {
    delete process.env.GITHUB_TOKEN;
    const out = await cortexGithubIngestRepo.handler(
      { repo: "octo/never-seen" },
      makeCtx(),
    );
    expect(out.action).toBe("github_not_configured");
  });

  it("returns ingesting on 200 and enqueues a github-sync job", async () => {
    process.env.GITHUB_TOKEN = "ghp_fake";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.startsWith("https://api.github.com/repos/octo/new-repo")) {
        return new Response(JSON.stringify({ id: 42, full_name: "octo/new-repo" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const out = await cortexGithubIngestRepo.handler({ repo: "octo/new-repo" }, makeCtx());
    expect(out.action).toBe("ingesting");
    expect(out.repo).toBe("octo/new-repo");
    expect(typeof out.jobId).toBe("string");
    const job = jobs.get(out.jobId!);
    expect(job?.kind).toBe("github-sync");
    // The writer goes through ensureLocalCopy, so the .local overlay
    // is where the new entry lands.
    const localPath = workspaceConfigPath.replace(/\.yaml$/, ".local.yaml");
    const raw = await readFile(localPath, "utf8").catch(() => readFile(workspaceConfigPath, "utf8"));
    const parsed = parseYaml(raw) as {
      adapters: { github: { config: { repos: string[] } } };
    };
    expect(parsed.adapters.github.config.repos).toContain("octo/new-repo");
  });

  it("returns not_accessible on 404 from GitHub", async () => {
    process.env.GITHUB_TOKEN = "ghp_fake";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });
    const out = await cortexGithubIngestRepo.handler(
      { repo: "octo/secret-repo" },
      makeCtx(),
    );
    expect(out.action).toBe("not_accessible");
    expect(out.repo).toBe("octo/secret-repo");
    // YAML untouched on either path — no .local overlay should be
    // written when we abort with not_accessible.
    const localPath = workspaceConfigPath.replace(/\.yaml$/, ".local.yaml");
    const raw = await readFile(localPath, "utf8").catch(() => readFile(workspaceConfigPath, "utf8"));
    const parsed = parseYaml(raw) as {
      adapters: { github: { config: { repos: string[] } } };
    };
    expect(parsed.adapters.github.config.repos).not.toContain("octo/secret-repo");
  });

  it("returns auth_expired on 401 from GitHub", async () => {
    process.env.GITHUB_TOKEN = "ghp_dead";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const out = await cortexGithubIngestRepo.handler(
      { repo: "octo/anything" },
      makeCtx(),
    );
    expect(out.action).toBe("auth_expired");
  });
});
