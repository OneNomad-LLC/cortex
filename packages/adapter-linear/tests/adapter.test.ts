import { describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@onenomad/cortex-core";
import { LinearAdapter } from "../src/adapter.js";

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
    secrets: { LINEAR_API_KEY: "lin_api_xxx" },
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

describe("LinearAdapter", () => {
  it("transform flattens title, description, comments into markdown", async () => {
    const adapter = new LinearAdapter();
    await adapter.init(
      makeCtx({ teamToProject: { ENG: "engineering" } }),
    );

    const issue = {
      id: "uuid-1",
      identifier: "ENG-42",
      title: "Ship Alpha v2",
      description: "We need to ship by Friday.",
      url: "https://linear.app/yourco/issue/ENG-42",
      createdAt: "2026-04-01T12:00:00.000Z",
      updatedAt: "2026-04-21T12:00:00.000Z",
      priorityLabel: "High",
      state: { name: "In Progress", type: "started" },
      team: { id: "t1", key: "ENG", name: "Engineering" },
      assignee: { id: "u1", name: "Alex", email: "alex@example.com" },
      creator: { id: "u2", name: "Sarah", email: "sarah@example.com" },
      labels: { nodes: [{ name: "urgent" }] },
      comments: {
        nodes: [
          {
            id: "c1",
            body: "Looking into this.",
            createdAt: "2026-04-02T10:00:00.000Z",
            user: { name: "Alex", email: "alex@example.com" },
          },
        ],
      },
    };

    const normalized = await adapter.transform({
      sourceId: "linear:issue:ENG-42",
      raw: issue,
    });

    expect(normalized.sourceType).toBe("linear");
    expect(normalized.title).toBe("ENG-42: Ship Alpha v2");
    expect(normalized.content).toContain("# ENG-42 · Ship Alpha v2");
    expect(normalized.content).toContain("Status: In Progress");
    expect(normalized.content).toContain("## Description");
    expect(normalized.content).toContain("ship by Friday");
    expect(normalized.content).toContain("## Comment — Alex");
    expect(normalized.content).toContain("Looking into this.");
    expect(normalized.rawMetadata.teamKey).toBe("ENG");
    expect(normalized.authors).toContain("sarah@example.com");
    expect(normalized.authors).toContain("alex@example.com");
  });

  it("classify maps team key to cortex project slug", async () => {
    const adapter = new LinearAdapter();
    await adapter.init(makeCtx({ teamToProject: { ENG: "engineering" } }));

    const classified = await adapter.classify(
      {
        sourceId: "x",
        sourceType: "linear",
        sourceUrl: "https://linear.app/",
        title: "t",
        content: "c",
        contentType: "doc",
        createdAt: new Date(),
        updatedAt: new Date(),
        authors: [],
        rawMetadata: { teamKey: "ENG" },
      },
      {},
    );
    expect(classified.projects).toEqual(["engineering"]);
    expect(classified.confidence).toBeGreaterThan(0.9);
  });

  it("init throws without LINEAR_API_KEY", async () => {
    const adapter = new LinearAdapter();
    const ctx = makeCtx({});
    ctx.secrets = {};
    await expect(adapter.init(ctx)).rejects.toThrow(/LINEAR_API_KEY/);
  });
});
