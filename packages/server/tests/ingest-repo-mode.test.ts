/**
 * Coverage for the `mode` parameter + SHA-gated re-derivation added
 * to `ingest_repo` in Slice B.
 *
 * Scope:
 *   - mode parameter: 'dossier' (default), 'full', 'both', invalid
 *   - dossier path: invokes the code-dossier pipeline, emits a typed
 *     memory count by category (brief/decisions/references)
 *   - full path: preserved (per-file walk, chunks count)
 *   - both: runs dossier then full, memories carry chunks AND brief
 *   - SHA gate: skipIfUnchanged=true with a matching prior brief
 *     returns { skipped:true, priorJobId }; with skipIfUnchanged=false
 *     the gate is bypassed and the pipeline runs
 *
 * The dossier pipeline is mocked via vi.mock so the suite doesn't
 * need a real LLM — Slice A's contract (run() returning
 * PipelineMemory[]; computeInputsSha returning string) is what's
 * under test from this side. Slice A's own unit tests cover the
 * extraction quality.
 */

import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the dossier package BEFORE importing ingest-repo so the import
// in the tool sees the mock. The mock returns the same fixed shape for
// every call; per-test tweaks happen via mockReturnValue / mockImplementation
// on `mockedDossier.codeDossierPipeline.run`.
vi.mock("@onenomad/przm-cortex-pipeline-code-dossier", () => {
  return {
    codeDossierPipeline: {
      id: "@onenomad/przm-cortex-pipeline-code-dossier",
      version: "test",
      run: vi.fn(),
    },
    computeInputsSha: vi.fn(),
  };
});

import { ingestRepo } from "../src/mcp/tools/ingest-repo.js";
import { jobs } from "../src/mcp/jobs.js";
import {
  codeDossierPipeline,
  computeInputsSha,
} from "@onenomad/przm-cortex-pipeline-code-dossier";
import { MemoryTypeRegistry } from "@onenomad/przm-cortex-core";
import type { ToolContext } from "../src/mcp/tool.js";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";

const mockedRun = codeDossierPipeline.run as unknown as ReturnType<typeof vi.fn>;
const mockedComputeSha = computeInputsSha as unknown as ReturnType<typeof vi.fn>;

let tmpRepoDir: string;

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

function fakeEngram(searchResults: EngramMemory[] = []): EngramClient {
  return {
    ingest: vi.fn(async () => ({ id: "fake-mem-1" })),
    search: vi.fn(async () => searchResults),
    healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    shutdown: vi.fn(async () => undefined),
    wipeAll: vi.fn(async () => ({ deleted: 0 })),
    // eslint-disable-next-line require-yield
    exportAll: async function* () {
      return;
    },
  } as unknown as EngramClient;
}

function makeCtx(engram: EngramClient): ToolContext {
  return {
    taxonomy: {
      findProject: () => undefined,
      findPerson: () => undefined,
    } as never,
    memoryTypes: new MemoryTypeRegistry(),
    logger: nullLogger(),
    engram,
    sessionWorkspace: "testws",
  };
}

beforeEach(async () => {
  tmpRepoDir = await mkdtemp(path.join(os.tmpdir(), "ingest-repo-mode-test-"));
  // A tiny but non-empty repo so file-tree-based hashes have something
  // to chew on. The dossier pipeline is mocked anyway, but the SHA-gate
  // path computes a hash over the real directory.
  await mkdir(path.join(tmpRepoDir, "src"), { recursive: true });
  await writeFile(path.join(tmpRepoDir, "README.md"), "# Test repo\n", "utf8");
  await writeFile(
    path.join(tmpRepoDir, "src", "index.ts"),
    "export const x = 1;\n",
    "utf8",
  );

  jobs._reset();
  mockedRun.mockReset();
  mockedComputeSha.mockReset();
  // Default mock: return one brief, one decision, one reference. Tests
  // that want a different shape override per-test.
  mockedRun.mockResolvedValue([
    {
      content: "Brief content",
      metadata: {
        domain: "work",
        source: "manual",
        source_id: "repo:test:brief",
        source_url: "file:///test",
        type: "brief",
        people: [],
        date: "2026-05-22T00:00:00.000Z",
        confidence: 1,
        title: "Test brief",
        tags: [],
      },
    },
    {
      content: "Decision content",
      metadata: {
        domain: "work",
        source: "manual",
        source_id: "repo:test:decision:0",
        source_url: "file:///test",
        type: "decision",
        people: [],
        date: "2026-05-22T00:00:00.000Z",
        confidence: 1,
        title: "Test decision",
        tags: [],
      },
    },
    {
      content: "Reference content",
      metadata: {
        domain: "work",
        source: "manual",
        source_id: "repo:test:reference:0",
        source_url: "file:///test",
        type: "reference",
        people: [],
        date: "2026-05-22T00:00:00.000Z",
        confidence: 1,
        title: "Test reference",
        tags: [],
      },
    },
  ]);
  mockedComputeSha.mockResolvedValue("sha-fixed-1");
});

afterEach(async () => {
  vi.restoreAllMocks();
  jobs._reset();
  try {
    await rm(tmpRepoDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("ingest_repo: mode parameter", () => {
  it("defaults mode to 'dossier'", () => {
    const parsed = ingestRepo.inputSchema.parse({ path: tmpRepoDir });
    expect(parsed.mode).toBe("dossier");
    expect(parsed.skipIfUnchanged).toBe(true);
  });

  it("accepts 'full' and 'both' as valid modes", () => {
    expect(
      ingestRepo.inputSchema.parse({ path: tmpRepoDir, mode: "full" }).mode,
    ).toBe("full");
    expect(
      ingestRepo.inputSchema.parse({ path: tmpRepoDir, mode: "both" }).mode,
    ).toBe("both");
  });

  it("rejects an unknown mode with a Zod error", () => {
    expect(() =>
      ingestRepo.inputSchema.parse({ path: tmpRepoDir, mode: "garbage" }),
    ).toThrow();
  });
});

describe("ingest_repo: mode='dossier' (the default)", () => {
  it("invokes the dossier pipeline and returns memories.brief/decisions/references", async () => {
    const engram = fakeEngram();
    const out = await ingestRepo.handler(
      ingestRepo.inputSchema.parse({
        path: tmpRepoDir,
        async: false,
      }),
      makeCtx(engram),
    );

    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(out.mode).toBe("dossier");
    expect(out.memories).toEqual({ brief: 1, decisions: 1, references: 1 });
    expect(out.skipped).toBeUndefined();
    // engram.ingest called once per emitted memory.
    expect((engram.ingest as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("stamps inputs_sha + dossier_source tags on the brief memory", async () => {
    const engram = fakeEngram();
    await ingestRepo.handler(
      ingestRepo.inputSchema.parse({ path: tmpRepoDir, async: false }),
      makeCtx(engram),
    );

    const ingestMock = engram.ingest as ReturnType<typeof vi.fn>;
    const briefCall = ingestMock.mock.calls.find((call) => {
      const md = (call[0] as { metadata?: { type?: string } }).metadata;
      return md?.type === "brief";
    });
    expect(briefCall).toBeDefined();
    const briefTags = (
      briefCall![0] as { metadata: { tags?: string[] } }
    ).metadata.tags;
    expect(briefTags).toContain("dossier_brief:1");
    expect(briefTags).toContain("inputs_sha:sha-fixed-1");
    expect(briefTags?.some((t) => t.startsWith("dossier_source:"))).toBe(true);
  });

  it("does NOT walk per-file when mode='dossier' (filesIngested stays 0)", async () => {
    const engram = fakeEngram();
    const out = await ingestRepo.handler(
      ingestRepo.inputSchema.parse({ path: tmpRepoDir, async: false }),
      makeCtx(engram),
    );
    expect(out.filesIngested).toBe(0);
    expect(out.chunksIngested).toBe(0);
  });
});

describe("ingest_repo: mode='full' (legacy per-file walk)", () => {
  it("does NOT invoke the dossier pipeline", async () => {
    // We expect the walker to dispatch ingestContent for each file,
    // which requires a session workspace. Use an empty repo so no
    // files trigger that path — the assertion is just "dossier never
    // called".
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "empty-repo-"));
    try {
      const engram = fakeEngram();
      const out = await ingestRepo.handler(
        ingestRepo.inputSchema.parse({
          path: emptyDir,
          async: false,
          mode: "full",
        }),
        makeCtx(engram),
      );
      expect(mockedRun).not.toHaveBeenCalled();
      expect(out.mode).toBe("full");
      expect(out.filesIngested).toBe(0);
      expect(out.memories).toEqual({ chunks: 0 });
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("ingest_repo: mode='both'", () => {
  it("invokes the dossier pipeline once and runs the full walk", async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "empty-repo-"));
    try {
      const engram = fakeEngram();
      const out = await ingestRepo.handler(
        ingestRepo.inputSchema.parse({
          path: emptyDir,
          async: false,
          mode: "both",
        }),
        makeCtx(engram),
      );
      expect(mockedRun).toHaveBeenCalledTimes(1);
      expect(out.mode).toBe("both");
      // Dossier memories populated; full chunks empty (empty dir).
      expect(out.memories.brief).toBe(1);
      expect(out.memories.decisions).toBe(1);
      expect(out.memories.references).toBe(1);
      expect(out.memories.chunks).toBe(0);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("ingest_repo: SHA-gated re-derivation", () => {
  function priorBriefMemory(sha: string, jobId = "prior-job-123"): EngramMemory {
    // Engram returns memories with tags on both `tags` and
    // `metadata.tags`. The SHA gate reads from `tags`.
    const tags = [
      "dossier_brief:1",
      // The source-id prefix the production code derives for a local
      // repo is `repo:<absolutePath>` — make the test memory match.
      `dossier_source:repo:${tmpRepoDir}`,
      `inputs_sha:${sha}`,
      `job_id:${jobId}`,
    ];
    return {
      id: "prior-brief-mem",
      content: "Prior brief content",
      type: "brief",
      tags,
      metadata: { tags, type: "brief" },
    };
  }

  it("skips the run when skipIfUnchanged=true (default) and SHA matches", async () => {
    const engram = fakeEngram([priorBriefMemory("sha-fixed-1")]);
    const out = await ingestRepo.handler(
      ingestRepo.inputSchema.parse({ path: tmpRepoDir, async: false }),
      makeCtx(engram),
    );

    expect(out.skipped).toBe(true);
    expect(out.skipReason).toBe("unchanged");
    expect(out.priorJobId).toBe("prior-job-123");
    // Pipeline never invoked because the gate fired before.
    expect(mockedRun).not.toHaveBeenCalled();
    // No new memories persisted on a skip.
    expect((engram.ingest as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(out.memories).toEqual({ brief: 0, decisions: 0, references: 0 });
  });

  it("ignores prior memories with a DIFFERENT SHA (gate doesn't fire)", async () => {
    const engram = fakeEngram([priorBriefMemory("sha-old-value")]);
    const out = await ingestRepo.handler(
      ingestRepo.inputSchema.parse({ path: tmpRepoDir, async: false }),
      makeCtx(engram),
    );

    expect(out.skipped).toBeUndefined();
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(out.memories.brief).toBe(1);
  });

  it("bypasses the SHA gate when skipIfUnchanged=false (forced re-run)", async () => {
    const engram = fakeEngram([priorBriefMemory("sha-fixed-1")]);
    const out = await ingestRepo.handler(
      ingestRepo.inputSchema.parse({
        path: tmpRepoDir,
        async: false,
        skipIfUnchanged: false,
      }),
      makeCtx(engram),
    );

    expect(out.skipped).toBeUndefined();
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(out.memories.brief).toBe(1);
  });

  it("treats an engram.search failure as 'no prior brief' and runs the pipeline", async () => {
    const engram = fakeEngram();
    (engram.search as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("engram unavailable"),
    );
    const out = await ingestRepo.handler(
      ingestRepo.inputSchema.parse({ path: tmpRepoDir, async: false }),
      makeCtx(engram),
    );
    // Soft-fail in the gate → still runs the pipeline.
    expect(out.skipped).toBeUndefined();
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });
});

describe("ingest_repo: job kind reflects mode", () => {
  it("creates an ingest-repo-dossier job when async + mode='dossier'", async () => {
    const engram = fakeEngram();
    const out = (await ingestRepo.handler(
      ingestRepo.inputSchema.parse({
        path: tmpRepoDir,
        async: true,
        mode: "dossier",
      }),
      makeCtx(engram),
    )) as { jobId?: string; mode: string };
    expect(out.jobId).toBeDefined();
    expect(out.mode).toBe("dossier");
    const job = jobs.get(out.jobId!);
    expect(job?.kind).toBe("ingest-repo-dossier");
  });

  it("creates an ingest-repo-full job when async + mode='full'", async () => {
    const engram = fakeEngram();
    const out = (await ingestRepo.handler(
      ingestRepo.inputSchema.parse({
        path: tmpRepoDir,
        async: true,
        mode: "full",
      }),
      makeCtx(engram),
    )) as { jobId?: string };
    expect(out.jobId).toBeDefined();
    const job = jobs.get(out.jobId!);
    expect(job?.kind).toBe("ingest-repo-full");
  });

  it("creates an ingest-repo-both job when async + mode='both'", async () => {
    const engram = fakeEngram();
    const out = (await ingestRepo.handler(
      ingestRepo.inputSchema.parse({
        path: tmpRepoDir,
        async: true,
        mode: "both",
      }),
      makeCtx(engram),
    )) as { jobId?: string };
    expect(out.jobId).toBeDefined();
    const job = jobs.get(out.jobId!);
    expect(job?.kind).toBe("ingest-repo-both");
  });
});
