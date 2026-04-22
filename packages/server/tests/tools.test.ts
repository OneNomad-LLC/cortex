import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadTaxonomy, type LoadedTaxonomy } from "../src/taxonomy.js";
import { listProjects } from "../src/mcp/tools/list-projects.js";
import { getProjectContext } from "../src/mcp/tools/get-project-context.js";
import type { ToolContext } from "../src/mcp/tool.js";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";
import type { PersonaClient } from "../src/clients/persona.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function fakeEngram(memories: EngramMemory[] = []): EngramClient {
  return {
    ingest: vi.fn(async () => ({ id: "fake" })),
    search: vi.fn(async () => memories),
    healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    shutdown: vi.fn(async () => undefined),
  };
}

function fakePersona(): PersonaClient {
  return {
    cognitiveLoad: vi.fn(async () => "medium"),
    signal: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    shutdown: vi.fn(async () => undefined),
  };
}

async function makeCtx(
  memories: EngramMemory[] = [],
): Promise<ToolContext & { taxonomy: LoadedTaxonomy }> {
  const taxonomy = await loadTaxonomy({
    projectsPath: path.join(fixturesDir, "projects.yaml"),
    peoplePath: path.join(fixturesDir, "people.yaml"),
  });
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return {
    taxonomy,
    logger,
    engram: fakeEngram(memories),
    persona: fakePersona(),
  };
}

describe("list_projects tool", () => {
  it("returns only active projects by default", async () => {
    const ctx = await makeCtx();
    const parsed = listProjects.inputSchema.parse({});
    const res = (await listProjects.handler(parsed, ctx)) as {
      projects: Array<{ slug: string }>;
    };
    expect(res.projects.map((p) => p.slug)).toEqual([
      "project-alpha",
      "project-beta",
    ]);
  });

  it("includes inactive when activeOnly=false", async () => {
    const ctx = await makeCtx();
    const parsed = listProjects.inputSchema.parse({ activeOnly: false });
    const res = (await listProjects.handler(parsed, ctx)) as {
      projects: Array<{ slug: string }>;
    };
    expect(res.projects).toHaveLength(3);
    expect(res.projects.map((p) => p.slug)).toContain("project-legacy");
  });
});

describe("get_project_context tool", () => {
  it("resolves by slug and returns people", async () => {
    const ctx = await makeCtx();
    const parsed = getProjectContext.inputSchema.parse({
      project: "project-alpha",
    });
    const res = (await getProjectContext.handler(parsed, ctx)) as {
      found: boolean;
      project?: { slug: string };
      people?: Array<{ slug: string }>;
    };
    expect(res.found).toBe(true);
    expect(res.project?.slug).toBe("project-alpha");
    expect(res.people?.map((p) => p.slug)).toEqual(["alex", "sarah"]);
  });

  it("resolves by alias", async () => {
    const ctx = await makeCtx();
    const parsed = getProjectContext.inputSchema.parse({ project: "Alpha" });
    const res = (await getProjectContext.handler(parsed, ctx)) as {
      found: boolean;
      project?: { slug: string };
    };
    expect(res.found).toBe(true);
    expect(res.project?.slug).toBe("project-alpha");
  });

  it("returns found=false with a hint for unknown projects", async () => {
    const ctx = await makeCtx();
    const parsed = getProjectContext.inputSchema.parse({ project: "ghost" });
    const res = (await getProjectContext.handler(parsed, ctx)) as {
      found: boolean;
      hint?: string;
    };
    expect(res.found).toBe(false);
    expect(res.hint).toContain("ghost");
  });

  it("maps Engram memories into recent_activity", async () => {
    const ctx = await makeCtx([
      {
        id: "mem-1",
        content: "Decided to ship Alpha v2 by Friday. Action item for alex.",
        metadata: {
          type: "decision",
          title: "Ship Alpha v2",
          date: "2026-04-20T12:00:00.000Z",
          source: "loom",
          source_url: "https://loom.example/abc",
        },
      },
    ]);
    const parsed = getProjectContext.inputSchema.parse({
      project: "project-alpha",
    });
    const res = (await getProjectContext.handler(parsed, ctx)) as {
      recent_activity: Array<Record<string, unknown>>;
    };
    expect(res.recent_activity).toHaveLength(1);
    expect(res.recent_activity[0]).toMatchObject({
      id: "mem-1",
      type: "decision",
      title: "Ship Alpha v2",
      source: "loom",
      url: "https://loom.example/abc",
    });
    expect((ctx.engram.search as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])
      .toMatchObject({ project: "project-alpha", domain: "work" });
  });

  it("skips the Engram query when recentLimit=0", async () => {
    const ctx = await makeCtx();
    const parsed = getProjectContext.inputSchema.parse({
      project: "project-alpha",
      recentLimit: 0,
    });
    const res = (await getProjectContext.handler(parsed, ctx)) as {
      recent_activity: unknown[];
    };
    expect(res.recent_activity).toEqual([]);
    expect(ctx.engram.search).not.toHaveBeenCalled();
  });

  it("swallows Engram errors and returns empty recent_activity", async () => {
    const ctx = await makeCtx();
    (ctx.engram.search as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("engram down"),
    );
    const parsed = getProjectContext.inputSchema.parse({
      project: "project-alpha",
    });
    const res = (await getProjectContext.handler(parsed, ctx)) as {
      found: boolean;
      recent_activity: unknown[];
    };
    expect(res.found).toBe(true);
    expect(res.recent_activity).toEqual([]);
  });
});
