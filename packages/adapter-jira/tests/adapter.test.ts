import { describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@onenomad/cortex-core";
import { JiraAdapter } from "../src/adapter.js";

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
    secrets: {
      ATLASSIAN_EMAIL: "me@example.com",
      ATLASSIAN_API_TOKEN: "token",
    },
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

describe("JiraAdapter", () => {
  it("transform flattens summary, description, and comments into markdown", async () => {
    const adapter = new JiraAdapter();
    await adapter.init(
      makeCtx({
        workspace: "yourcompany",
        projects: ["ENG"],
        projectToCortex: { ENG: "engineering" },
      }),
    );

    const issue = {
      id: "10001",
      key: "ENG-42",
      self: "https://yourcompany.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Ship Alpha v2",
        description: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "We need to ship by Friday." }] },
          ],
        },
        issuetype: { name: "Story" },
        status: { name: "In Progress" },
        priority: { name: "High" },
        assignee: { accountId: "a1", displayName: "Alex", emailAddress: "alex@example.com" },
        reporter: { accountId: "r1", displayName: "Sarah", emailAddress: "sarah@example.com" },
        project: { key: "ENG", name: "Engineering", id: "123" },
        created: "2026-04-01T12:00:00.000Z",
        updated: "2026-04-21T12:00:00.000Z",
        labels: ["urgent"],
        comment: {
          comments: [
            {
              id: "c1",
              author: { displayName: "Alex" },
              created: "2026-04-02T10:00:00.000Z",
              body: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Looking into this." }],
                  },
                ],
              },
            },
          ],
        },
      },
    };

    const normalized = await adapter.transform({
      sourceId: "jira:issue:ENG-42",
      raw: issue,
    });

    expect(normalized.sourceType).toBe("jira");
    expect(normalized.title).toBe("ENG-42: Ship Alpha v2");
    expect(normalized.content).toContain("# ENG-42 · Ship Alpha v2");
    expect(normalized.content).toContain("Type: Story");
    expect(normalized.content).toContain("## Description");
    expect(normalized.content).toContain("We need to ship by Friday.");
    expect(normalized.content).toContain("## Comment — Alex");
    expect(normalized.content).toContain("Looking into this.");
    expect(normalized.sourceUrl).toBe(
      "https://yourcompany.atlassian.net/browse/ENG-42",
    );
    expect(normalized.rawMetadata.projectKey).toBe("ENG");
    expect(normalized.authors).toContain("sarah@example.com");
    expect(normalized.authors).toContain("alex@example.com");
  });

  it("classify maps project key to cortex project slug", async () => {
    const adapter = new JiraAdapter();
    await adapter.init(
      makeCtx({
        workspace: "yourcompany",
        projectToCortex: { ENG: "engineering" },
      }),
    );

    const classified = await adapter.classify(
      {
        sourceId: "x",
        sourceType: "jira",
        sourceUrl: "https://x",
        title: "t",
        content: "c",
        contentType: "doc",
        createdAt: new Date(),
        updatedAt: new Date(),
        authors: [],
        rawMetadata: { projectKey: "ENG" },
      },
      {},
    );
    expect(classified.projects).toEqual(["engineering"]);
    expect(classified.confidence).toBeGreaterThan(0.9);
  });

  it("init throws when Atlassian secrets are missing", async () => {
    const adapter = new JiraAdapter();
    const ctx = makeCtx({ workspace: "yourcompany" });
    ctx.secrets = {};
    await expect(adapter.init(ctx)).rejects.toThrow(/ATLASSIAN_EMAIL/);
  });
});
