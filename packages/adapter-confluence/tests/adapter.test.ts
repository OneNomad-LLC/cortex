import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@onenomad/przm-cortex-core";
import { ConfluenceAdapter } from "../src/adapter.js";

const fixture = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "page.json"),
    "utf8",
  ),
) as Record<string, unknown>;

function makeCtx(cfg: Record<string, unknown>): AdapterContext {
  const noop = vi.fn();
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
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

describe("ConfluenceAdapter", () => {
  it("transform produces a NormalizedItem from storage format", async () => {
    const adapter = new ConfluenceAdapter();
    await adapter.init(
      makeCtx({ workspace: "yourcompany", spaceToProject: { ENG: "engineering" } }),
    );

    const normalized = await adapter.transform({
      sourceId: "confluence:page:100001",
      raw: { page: fixture, spaceKey: "ENG" },
    });

    expect(normalized.sourceType).toBe("confluence");
    expect(normalized.title).toBe("Team Onboarding");
    expect(normalized.content).toContain("# Day 1");
    expect(normalized.content).toContain("## Accounts");
    expect(normalized.content).toContain("Read this page first.");
    expect(normalized.content).toContain("- Check email");
    expect(normalized.sourceUrl).toBe(
      "https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/100001/Team+Onboarding",
    );
    expect(normalized.contentType).toBe("doc");
    expect(normalized.parentId).toBe("99999");
    expect(normalized.rawMetadata.spaceKey).toBe("ENG");
  });

  it("rule-based classifier maps space key to project", async () => {
    const adapter = new ConfluenceAdapter();
    await adapter.init(
      makeCtx({ workspace: "yourcompany", spaceToProject: { ENG: "engineering" } }),
    );

    const normalized = await adapter.transform({
      sourceId: "confluence:page:100001",
      raw: { page: fixture, spaceKey: "ENG" },
    });
    const classified = await adapter.classify(normalized, {});

    expect(classified.projects).toEqual(["engineering"]);
    expect(classified.confidence).toBeGreaterThan(0.9);
    expect(classified.classificationMethod).toBe("rule");
  });

  it("spaceToContext wins over spaceToProject and carries engagement/subBrand/team", async () => {
    const adapter = new ConfluenceAdapter();
    await adapter.init(
      makeCtx({
        workspace: "yourcompany",
        spaceToProject: { ENG: "engineering" },
        spaceToContext: {
          ENG: {
            engagement: "acme-corp",
            subBrand: "alpha-retail",
            project: "pos-refresh",
            team: "alpha",
          },
        },
      }),
    );

    const normalized = await adapter.transform({
      sourceId: "confluence:page:100001",
      raw: { page: fixture, spaceKey: "ENG" },
    });
    const classified = await adapter.classify(normalized, {});

    expect(classified.projects).toEqual(["pos-refresh"]);
    expect(classified.engagement).toBe("acme-corp");
    expect(classified.subBrand).toBe("alpha-retail");
    expect(classified.team).toBe("alpha");
    expect(classified.confidence).toBeGreaterThanOrEqual(0.95);
    expect(classified.classificationMethod).toBe("rule");
  });

  it("returns unclassified (confidence 0) when no rule matches", async () => {
    const adapter = new ConfluenceAdapter();
    await adapter.init(
      makeCtx({ workspace: "yourcompany", spaceToProject: {} }),
    );

    const normalized = await adapter.transform({
      sourceId: "confluence:page:100001",
      raw: { page: fixture, spaceKey: "ENG" },
    });
    const classified = await adapter.classify(normalized, {});

    expect(classified.projects).toEqual([]);
    expect(classified.confidence).toBe(0);
  });

  it("init fails when secrets are missing", async () => {
    const adapter = new ConfluenceAdapter();
    const ctx = makeCtx({ workspace: "yourcompany" });
    ctx.secrets = {};
    await expect(adapter.init(ctx)).rejects.toThrow(/ATLASSIAN_EMAIL/);
  });

  it("declares pipeline-doc so the server routes output correctly", () => {
    const adapter = new ConfluenceAdapter();
    expect(adapter.pipelines).toContain("@onenomad/przm-cortex-pipeline-doc");
  });
});
