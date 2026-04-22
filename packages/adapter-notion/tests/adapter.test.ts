import { describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@cortex/core";
import { NotionAdapter } from "../src/adapter.js";

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
    secrets: { NOTION_API_KEY: "secret_xxx" },
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

describe("NotionAdapter", () => {
  it("transform extracts title, body, and metadata from page + blocks", async () => {
    const adapter = new NotionAdapter();
    await adapter.init(
      makeCtx({
        databases: ["db-xyz"],
        databaseToProject: { "db-xyz": "engineering" },
      }),
    );

    const page = {
      id: "p-1",
      object: "page" as const,
      created_time: "2026-04-01T12:00:00.000Z",
      last_edited_time: "2026-04-21T12:00:00.000Z",
      parent: { type: "database_id" as const, database_id: "db-xyz" },
      archived: false,
      properties: {
        Name: {
          id: "title",
          type: "title",
          title: [{ plain_text: "Onboarding Doc" }],
        },
      },
      url: "https://notion.so/p-1",
    };
    const blocks = [
      {
        id: "b-1",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "Welcome to the team." }] },
      },
    ];

    const normalized = await adapter.transform({
      sourceId: "notion:page:p-1",
      raw: { page, blocks, sourceDatabaseId: "db-xyz" },
    });

    expect(normalized.sourceType).toBe("notion");
    expect(normalized.title).toBe("Onboarding Doc");
    expect(normalized.content).toContain("# Onboarding Doc");
    expect(normalized.content).toContain("Welcome to the team.");
    expect(normalized.sourceUrl).toBe("https://notion.so/p-1");
    expect(normalized.rawMetadata.databaseId).toBe("db-xyz");
  });

  it("classify maps database id to project slug", async () => {
    const adapter = new NotionAdapter();
    await adapter.init(
      makeCtx({
        databases: ["db-xyz"],
        databaseToProject: { "db-xyz": "engineering" },
      }),
    );

    const item = {
      sourceId: "x",
      sourceType: "notion" as const,
      sourceUrl: "https://n",
      title: "t",
      content: "c",
      contentType: "doc" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
      authors: [],
      rawMetadata: { databaseId: "db-xyz" },
    };

    const classified = await adapter.classify(item, {});
    expect(classified.projects).toEqual(["engineering"]);
    expect(classified.confidence).toBeGreaterThan(0.9);
  });

  it("falls back to defaultProject when no rule matches", async () => {
    const adapter = new NotionAdapter();
    await adapter.init(
      makeCtx({
        databases: ["db-xyz"],
        databaseToProject: {},
        defaultProject: "inbox",
      }),
    );

    const classified = await adapter.classify(
      {
        sourceId: "x",
        sourceType: "notion",
        sourceUrl: "https://n",
        title: "t",
        content: "c",
        contentType: "doc",
        createdAt: new Date(),
        updatedAt: new Date(),
        authors: [],
        rawMetadata: { databaseId: "other-db" },
      },
      {},
    );
    expect(classified.projects).toEqual(["inbox"]);
  });

  it("init throws without NOTION_API_KEY", async () => {
    const adapter = new NotionAdapter();
    const ctx = makeCtx({ databases: ["db-1"] });
    ctx.secrets = {};
    await expect(adapter.init(ctx)).rejects.toThrow(/NOTION_API_KEY/);
  });
});
