import { describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@onenomad/przm-cortex-core";
import {
  GithubAdapter,
  githubConfigSchema,
  type GithubMode,
  type GithubRepoIngestRequest,
  type GithubRepoIngestResult,
  type RepoIngestFn,
} from "../src/adapter.js";

/**
 * Build a minimal AdapterContext suitable for routing tests. The real
 * GithubClient is never reached — the delegated path short-circuits as
 * soon as `repoIngester` is set, so the on-init token check is the only
 * external touchpoint we have to satisfy.
 */
function makeCtx(cfg: Record<string, unknown>): AdapterContext {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    logger,
    config: cfg,
    secrets: { GITHUB_TOKEN: "ghp_test_xxx" },
    signal: new AbortController().signal,
    engram: {
      ingest: vi.fn(async () => ({ id: "fake" })),
      healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    },
    taxonomy: {
      listProjects: () => [],
      findProjectBySlug: () => undefined,
      findProject: () => undefined,
      listPeople: () => [],
      findPersonBySlug: () => undefined,
      findPersonByEmail: () => undefined,
      findPerson: () => undefined,
      findSelf: () => undefined,
    },
    llm: { raw: null, complete: vi.fn() },
  };
}

/**
 * Drain an AsyncIterable to an array. fetch() in the delegated path
 * yields nothing — the assertions here check the side effects on the
 * stubbed ingester, not what fetch produced.
 */
async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("GithubAdapter — mode routing", () => {
  it("routes every repo to the adapter-level mode when no overrides set", async () => {
    const calls: GithubRepoIngestRequest[] = [];
    const ingester: RepoIngestFn = async (
      req,
    ): Promise<GithubRepoIngestResult> => {
      calls.push(req);
      return { skipped: false, dossierSections: 5 };
    };

    const adapter = new GithubAdapter();
    await adapter.init(
      makeCtx({
        repos: ["acme/web", "acme/api", "acme/docs"],
        mode: "dossier",
        repoToProject: { "acme/web": "platform", "acme/api": "platform" },
        defaultProject: "general",
      }),
    );
    adapter.setRepoIngester(ingester);

    const items = await drain(adapter.fetch());
    expect(items).toHaveLength(0); // Delegated path yields nothing.
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.mode)).toEqual(["dossier", "dossier", "dossier"]);
    expect(calls.map((c) => c.path)).toEqual([
      "https://github.com/acme/web.git",
      "https://github.com/acme/api.git",
      "https://github.com/acme/docs.git",
    ]);
    expect(calls.map((c) => c.sourceUrl)).toEqual([
      "https://github.com/acme/web",
      "https://github.com/acme/api",
      "https://github.com/acme/docs",
    ]);
    // repoToProject wins where defined; defaultProject covers the rest.
    expect(calls.map((c) => c.project)).toEqual([
      "platform",
      "platform",
      "general",
    ]);
    // Scheduled syncs always opt into SHA-gating.
    expect(calls.every((c) => c.skipIfUnchanged === true)).toBe(true);
  });

  it("honors per-repo overrides while leaving unmentioned repos on the default", async () => {
    const calls: GithubRepoIngestRequest[] = [];
    const ingester: RepoIngestFn = async (req) => {
      calls.push(req);
      return { skipped: false };
    };

    const adapter = new GithubAdapter();
    await adapter.init(
      makeCtx({
        repos: ["acme/web", "acme/legacy", "acme/api"],
        mode: "full",
        repoModes: {
          "acme/legacy": "dossier",
          "acme/api": "both",
          // acme/web absent — inherits adapter-level `full`.
        },
        defaultProject: "general",
      }),
    );
    adapter.setRepoIngester(ingester);

    await drain(adapter.fetch());
    const byRepo = new Map(calls.map((c) => [c.path, c.mode] as const));
    expect(byRepo.get("https://github.com/acme/web.git")).toBe("full");
    expect(byRepo.get("https://github.com/acme/legacy.git")).toBe("dossier");
    expect(byRepo.get("https://github.com/acme/api.git")).toBe("both");
  });

  it("resolveMode reflects per-repo overrides + adapter default", async () => {
    const adapter = new GithubAdapter();
    await adapter.init(
      makeCtx({
        repos: ["acme/web", "acme/legacy"],
        mode: "dossier",
        repoModes: { "acme/legacy": "full" },
      }),
    );
    expect(adapter.resolveMode("acme/web")).toBe("dossier");
    expect(adapter.resolveMode("acme/legacy")).toBe("full");
    // Unknown repo falls back to the adapter default — useful when the
    // dashboard asks "what would this repo route to" before it's been
    // added.
    expect(adapter.resolveMode("acme/never-seen")).toBe("dossier");
  });

  it("defaults `mode` to dossier when the config block omits it", () => {
    const parsed = githubConfigSchema.parse({ repos: ["acme/web"] });
    expect(parsed.mode).toBe("dossier");
    expect(parsed.repoModes).toBeUndefined();
  });

  it("rejects an unknown mode at the schema level", () => {
    const result = githubConfigSchema.safeParse({
      repos: ["acme/web"],
      mode: "compact" as GithubMode,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["mode"]);
    }
  });

  it("rejects an unknown per-repo override mode at the schema level", () => {
    const result = githubConfigSchema.safeParse({
      repos: ["acme/web"],
      mode: "dossier",
      repoModes: { "acme/web": "compact" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["repoModes", "acme/web"]);
    }
  });

  it("swallows per-repo ingester failures and logs warn", async () => {
    const ingester: RepoIngestFn = vi.fn(async (req) => {
      if (req.path.includes("legacy")) throw new Error("boom");
      return { skipped: false };
    });

    const ctx = makeCtx({
      repos: ["acme/web", "acme/legacy", "acme/api"],
      mode: "dossier",
    });
    const adapter = new GithubAdapter();
    await adapter.init(ctx);
    adapter.setRepoIngester(ingester);

    // fetch() must not throw — one bad repo shouldn't poison the
    // whole sync run.
    await expect(drain(adapter.fetch())).resolves.toEqual([]);
    expect(ingester).toHaveBeenCalledTimes(3);
    // The failing repo logged a warning; successful repos logged info.
    const warn = ctx.logger.warn as ReturnType<typeof vi.fn>;
    const info = ctx.logger.info as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledWith(
      "github.repo_ingest_failed",
      expect.objectContaining({ repo: "acme/legacy", mode: "dossier" }),
    );
    expect(info).toHaveBeenCalledWith(
      "github.repo_ingested",
      expect.objectContaining({ repo: "acme/web", mode: "dossier" }),
    );
  });

  it("throws when `repos` is empty (mirrors legacy behavior)", async () => {
    const adapter = new GithubAdapter();
    await adapter.init(makeCtx({ repos: [], mode: "dossier" }));
    adapter.setRepoIngester(async () => ({ skipped: false }));
    await expect(drain(adapter.fetch())).rejects.toThrow(
      /repos.*non-empty/,
    );
  });
});
