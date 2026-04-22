import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getApproval,
  readApprovals,
  setApproval,
  writeApprovals,
} from "../src/approvals.js";
import { approveResearch } from "../src/mcp/tools/approve-research.js";
import type { ToolContext } from "../src/mcp/tool.js";
import { loadTaxonomy } from "../src/taxonomy.js";
import { fileURLToPath } from "node:url";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

let tmpDir: string;
let approvalsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cortex-approvals-"));
  approvalsPath = path.join(tmpDir, "approvals.json");
  process.env.CORTEX_APPROVALS_PATH = approvalsPath;
});
afterEach(async () => {
  delete process.env.CORTEX_APPROVALS_PATH;
  await rm(tmpDir, { recursive: true, force: true });
});

function fakeEngram(memories: EngramMemory[] = []): EngramClient {
  return {
    ingest: vi.fn(async () => ({ id: "fake" })),
    search: vi.fn(async () => memories),
    healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    shutdown: vi.fn(async () => undefined),
  };
}

async function makeCtx(memories: EngramMemory[] = []): Promise<ToolContext> {
  const taxonomy = await loadTaxonomy({
    projectsPath: path.join(fixturesDir, "projects.yaml"),
    peoplePath: path.join(fixturesDir, "people.yaml"),
  });
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return logger;
    },
  };
  return {
    taxonomy,
    logger,
    engram: fakeEngram(memories),
    persona: {
      cognitiveLoad: vi.fn(async () => "medium"),
      signal: vi.fn(async () => undefined),
      healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
      shutdown: vi.fn(async () => undefined),
    },
  };
}

describe("approvals file", () => {
  it("returns an empty file when none exists", async () => {
    const file = await readApprovals();
    expect(file.version).toBe(1);
    expect(file.sources).toEqual({});
  });

  it("persists set + get", async () => {
    await setApproval({
      sourceId: "cortex:research:rate-limiting",
      status: "approved",
      reviewer: "alex",
      note: "Reviewed 2026-04-22",
    });
    const record = await getApproval("cortex:research:rate-limiting");
    expect(record?.status).toBe("approved");
    expect(record?.reviewer).toBe("alex");
  });

  it("round-trips via writeApprovals", async () => {
    await writeApprovals({
      version: 1,
      sources: {
        "cortex:research:a": {
          status: "revoked",
          decidedAt: "2026-04-22T00:00:00.000Z",
        },
      },
    });
    const file = await readApprovals();
    expect(file.sources["cortex:research:a"]?.status).toBe("revoked");
  });
});

describe("approve_research tool", () => {
  it("records an approval and attempts best-effort re-ingest", async () => {
    const ctx = await makeCtx([
      {
        id: "b1",
        content: "# Research brief",
        metadata: {
          type: "brief",
          source_id: "cortex:research:rate-limiting#brief",
          status: "draft",
        },
      },
    ]);

    const parsed = approveResearch.inputSchema.parse({
      sourceId: "cortex:research:rate-limiting",
      status: "approved",
      reviewer: "alex",
    });
    const res = (await approveResearch.handler(parsed, ctx)) as {
      status: string;
      reIngestAttempted: boolean;
      reIngestSuccess: boolean;
    };

    expect(res.status).toBe("approved");
    expect(res.reIngestAttempted).toBe(true);
    expect(res.reIngestSuccess).toBe(true);

    const record = await getApproval("cortex:research:rate-limiting");
    expect(record?.status).toBe("approved");
    expect(record?.reviewer).toBe("alex");

    // Re-ingest was called with status=approved on the metadata.
    const call = (ctx.engram.ingest as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect((call?.metadata as { status?: string } | undefined)?.status).toBe(
      "approved",
    );
  });

  it("rejects non-research source ids with a hint", async () => {
    const ctx = await makeCtx();
    const parsed = approveResearch.inputSchema.parse({
      sourceId: "confluence:page:123",
    });
    const res = (await approveResearch.handler(parsed, ctx)) as {
      hint?: string;
      reIngestAttempted: boolean;
    };
    expect(res.hint).toContain("reference");
    expect(res.reIngestAttempted).toBe(false);
  });
});
