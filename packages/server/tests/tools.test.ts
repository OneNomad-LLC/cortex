import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTaxonomy, type LoadedTaxonomy } from "../src/taxonomy.js";
import { listProjects } from "../src/mcp/tools/list-projects.js";
import { getProjectContext } from "../src/mcp/tools/get-project-context.js";
import type { ToolContext } from "../src/mcp/tool.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

async function makeCtx(): Promise<ToolContext & { taxonomy: LoadedTaxonomy }> {
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
  return { taxonomy, logger };
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
});
