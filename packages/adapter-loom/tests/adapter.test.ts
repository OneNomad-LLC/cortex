import { describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@onenomad/cortex-core";
import { LoomAdapter } from "../src/adapter.js";

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
    secrets: { LOOM_API_KEY: "loom_xxx" },
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
    },
    llm: { raw: null, complete: vi.fn() },
  };
}

describe("LoomAdapter", () => {
  it("transform concatenates description + transcript and fills metadata", async () => {
    const adapter = new LoomAdapter();
    await adapter.init(
      makeCtx({
        workspace: "yourco",
        folderToProject: { "fld-1": "engineering" },
      }),
    );

    const raw = {
      recording: {
        id: "rec-42",
        title: "Alpha planning",
        description: "Quick sync on v2.",
        url: "https://loom.com/share/rec-42",
        folderId: "fld-1",
        createdAt: "2026-04-22T12:00:00.000Z",
        updatedAt: "2026-04-22T12:45:00.000Z",
        durationSeconds: 2700,
        owner: { id: "u-1", name: "Alex", email: "alex@example.com" },
        viewers: [{ name: "Sarah", email: "sarah@example.com" }],
      },
      transcript: {
        language: "en-US",
        segments: [
          { speaker: "Alex", text: "Hi team." },
          { speaker: "Alex", text: "Plan is locked." },
          { speaker: "Sarah", text: "Sounds good." },
        ],
      },
    };

    const normalized = await adapter.transform({
      sourceId: "loom:rec:rec-42",
      raw,
    });

    expect(normalized.sourceType).toBe("loom");
    expect(normalized.title).toBe("Alpha planning");
    expect(normalized.contentType).toBe("meeting");
    expect(normalized.content).toContain("Quick sync on v2.");
    expect(normalized.content).toContain("Alex: Hi team. Plan is locked.");
    expect(normalized.content).toContain("Sarah: Sounds good.");
    expect(normalized.authors).toContain("alex@example.com");
    expect(normalized.authors).toContain("sarah@example.com");
    expect(normalized.rawMetadata.folderId).toBe("fld-1");
    expect(normalized.rawMetadata.hasTranscript).toBe(true);
    expect(normalized.rawMetadata.language).toBe("en-US");
  });

  it("classify maps folderId to project slug", async () => {
    const adapter = new LoomAdapter();
    await adapter.init(
      makeCtx({
        workspace: "yourco",
        folderToProject: { "fld-1": "engineering" },
      }),
    );

    const classified = await adapter.classify(
      {
        sourceId: "x",
        sourceType: "loom",
        sourceUrl: "https://loom.com/x",
        title: "t",
        content: "c",
        contentType: "meeting",
        createdAt: new Date(),
        updatedAt: new Date(),
        authors: [],
        rawMetadata: { folderId: "fld-1" },
      },
      {},
    );
    expect(classified.projects).toEqual(["engineering"]);
    expect(classified.confidence).toBeGreaterThan(0.9);
  });

  it("falls back to defaultProject when folder has no rule", async () => {
    const adapter = new LoomAdapter();
    await adapter.init(
      makeCtx({
        workspace: "yourco",
        folderToProject: {},
        defaultProject: "inbox",
      }),
    );

    const classified = await adapter.classify(
      {
        sourceId: "x",
        sourceType: "loom",
        sourceUrl: "https://loom.com/x",
        title: "t",
        content: "c",
        contentType: "meeting",
        createdAt: new Date(),
        updatedAt: new Date(),
        authors: [],
        rawMetadata: { folderId: "fld-unknown" },
      },
      {},
    );
    expect(classified.projects).toEqual(["inbox"]);
    expect(classified.confidence).toBe(0.5);
  });

  it("declares pipeline-meeting so the server routes output correctly", () => {
    const adapter = new LoomAdapter();
    expect(adapter.pipelines).toEqual(["@onenomad/cortex-pipeline-meeting"]);
  });

  it("init throws without LOOM_API_KEY", async () => {
    const adapter = new LoomAdapter();
    const ctx = makeCtx({ workspace: "yourco" });
    ctx.secrets = {};
    await expect(adapter.init(ctx)).rejects.toThrow(/LOOM_API_KEY/);
  });
});
