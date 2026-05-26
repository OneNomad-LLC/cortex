import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTypeRegistry } from "@onenomad/przm-cortex-core";
import { createWorkspace } from "../src/cli/workspace/manager.js";
import {
  evictStaleSessions,
  runWithSession,
  setSessionWorkspace,
} from "../src/session-context.js";
import { TaxonomyCache } from "../src/taxonomy-cache.js";
import { addProject } from "../src/mcp/tools/add-project.js";
import { listProjects } from "../src/mcp/tools/list-projects.js";
import { ingestContent } from "../src/mcp/tools/ingest-content.js";
import { NoWorkspaceBoundError } from "../src/session-workspace-helpers.js";
import type { ToolContext } from "../src/mcp/tool.js";
import type { EngramClient } from "../src/clients/engram.js";

/**
 * End-to-end tests for the restored project-management tools. They run
 * against a real temp workspace (env-overridden state + workspace root,
 * same harness as session-workspace-helpers.test.ts) and a real
 * TaxonomyCache so the add → invalidate → reload → ingest-gate path is
 * exercised exactly as server.ts wires it. The Engram client is faked
 * since none of these tools' assertions depend on storage behavior.
 */

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

function fakeEngram(): EngramClient {
  return {
    ingest: vi.fn(async () => ({ id: "fake" })),
    search: vi.fn(async () => []),
    healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    shutdown: vi.fn(async () => undefined),
  } as unknown as EngramClient;
}

describe("project tools (add_project / list_projects)", () => {
  let tmp: string;
  let cache: TaxonomyCache;
  let engram: EngramClient;
  const originalState = process.env.PRZM_CORTEX_STATE_PATH;
  const originalRoot = process.env.PRZM_CORTEX_WORKSPACES_ROOT;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "cortex-projtools-"));
    process.env.PRZM_CORTEX_STATE_PATH = path.join(tmp, "state.json");
    process.env.PRZM_CORTEX_WORKSPACES_ROOT = path.join(tmp, "workspaces");
    evictStaleSessions(0);
    cache = new TaxonomyCache(silentLogger as never);
    engram = fakeEngram();
  });

  afterEach(async () => {
    if (originalState === undefined) delete process.env.PRZM_CORTEX_STATE_PATH;
    else process.env.PRZM_CORTEX_STATE_PATH = originalState;
    if (originalRoot === undefined) delete process.env.PRZM_CORTEX_WORKSPACES_ROOT;
    else process.env.PRZM_CORTEX_WORKSPACES_ROOT = originalRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  // Build a per-call ToolContext the way server.ts does: a fresh
  // taxonomy from the cache (so an invalidate between calls is honored)
  // plus the invalidate hook bound to that same cache.
  async function ctxFor(slug: string): Promise<ToolContext> {
    return {
      taxonomy: await cache.forWorkspace(slug),
      memoryTypes: new MemoryTypeRegistry(),
      logger: silentLogger as never,
      engram,
      sessionWorkspace: slug,
      invalidateTaxonomy: (s) => cache.invalidate(s),
    };
  }

  it("list_projects returns the implicit default on a fresh workspace", async () => {
    await createWorkspace({ slug: "fresh" });
    await runWithSession("s1", async () => {
      setSessionWorkspace("s1", "fresh");
      const parsed = listProjects.inputSchema.parse({});
      const res = await listProjects.handler(parsed, await ctxFor("fresh"));
      expect(res.workspace).toBe("fresh");
      expect(res.projects).toHaveLength(1);
      expect(res.projects[0]).toMatchObject({ slug: "default", implicit: true });
    });
  });

  it("add_project creates a project that list_projects then surfaces", async () => {
    await createWorkspace({ slug: "ws" });
    await runWithSession("s1", async () => {
      setSessionWorkspace("s1", "ws");

      const addParsed = addProject.inputSchema.parse({
        slug: "agn-rebuild",
        name: "AGN Rebuild",
        aliases: ["AGN"],
      });
      const added = await addProject.handler(addParsed, await ctxFor("ws"));
      expect(added).toMatchObject({
        slug: "agn-rebuild",
        created: true,
        already_exists: false,
      });

      const listParsed = listProjects.inputSchema.parse({});
      const listed = await listProjects.handler(listParsed, await ctxFor("ws"));
      const slugs = listed.projects.map((p) => p.slug);
      expect(slugs).toContain("default");
      expect(slugs).toContain("agn-rebuild");
      const row = listed.projects.find((p) => p.slug === "agn-rebuild");
      expect(row).toMatchObject({ name: "AGN Rebuild", aliases: ["AGN"] });
    });
  });

  it("re-running add_project with the same slug does not create a duplicate", async () => {
    await createWorkspace({ slug: "ws" });
    await runWithSession("s1", async () => {
      setSessionWorkspace("s1", "ws");

      const parsed = addProject.inputSchema.parse({ slug: "agn-rebuild" });
      const first = await addProject.handler(parsed, await ctxFor("ws"));
      expect(first.created).toBe(true);

      const second = await addProject.handler(parsed, await ctxFor("ws"));
      expect(second).toMatchObject({
        slug: "agn-rebuild",
        created: false,
        already_exists: true,
        matched_on: { kind: "slug", value: "agn-rebuild" },
      });

      const listed = await listProjects.handler(
        listProjects.inputSchema.parse({}),
        await ctxFor("ws"),
      );
      const matches = listed.projects.filter((p) => p.slug === "agn-rebuild");
      expect(matches).toHaveLength(1);
    });
  });

  it("dedupes when a new alias collides with an existing alias", async () => {
    await createWorkspace({ slug: "ws" });
    await runWithSession("s1", async () => {
      setSessionWorkspace("s1", "ws");

      await addProject.handler(
        addProject.inputSchema.parse({ slug: "agn-rebuild", aliases: ["AGN"] }),
        await ctxFor("ws"),
      );

      // Different slug, but alias "agn" normalizes to the same key as
      // the existing "AGN" — must return the original, not a new row.
      const dup = await addProject.handler(
        addProject.inputSchema.parse({ slug: "agn-redo", aliases: ["agn"] }),
        await ctxFor("ws"),
      );
      expect(dup).toMatchObject({
        slug: "agn-rebuild",
        created: false,
        already_exists: true,
        matched_on: { kind: "alias", value: "agn" },
      });
    });
  });

  it("dedupes when a new slug collides with an existing project's alias", async () => {
    await createWorkspace({ slug: "ws" });
    await runWithSession("s1", async () => {
      setSessionWorkspace("s1", "ws");

      await addProject.handler(
        addProject.inputSchema.parse({ slug: "agn-rebuild", aliases: ["agn"] }),
        await ctxFor("ws"),
      );

      const dup = await addProject.handler(
        addProject.inputSchema.parse({ slug: "agn" }),
        await ctxFor("ws"),
      );
      expect(dup).toMatchObject({
        slug: "agn-rebuild",
        created: false,
        already_exists: true,
        matched_on: { kind: "slug", value: "agn" },
      });
    });
  });

  it("rejects a non-kebab-case slug at the schema boundary", () => {
    expect(() => addProject.inputSchema.parse({ slug: "Not Kebab" })).toThrow(
      /kebab-case/i,
    );
  });

  it("both tools throw NoWorkspaceBoundError when no workspace is bound", async () => {
    await runWithSession("s1", async () => {
      // session never bound, no CLI active pointer
      await expect(
        addProject.handler(
          addProject.inputSchema.parse({ slug: "agn-rebuild" }),
          { ...(await ctxNoWorkspace()) },
        ),
      ).rejects.toBeInstanceOf(NoWorkspaceBoundError);
      await expect(
        listProjects.handler(listProjects.inputSchema.parse({}), {
          ...(await ctxNoWorkspace()),
        }),
      ).rejects.toBeInstanceOf(NoWorkspaceBoundError);
    });
  });

  // Acceptance bridge: a freshly added project must be immediately
  // accepted by ingest_content in the same session — i.e. the
  // "unknown project '<slug>'" gate (ingest-content.ts) no longer
  // fires. Driven through the real handler with a pass-through type
  // ("decision") so no LLM pipeline is needed.
  it("ingest_content accepts a freshly added project slug", async () => {
    await createWorkspace({ slug: "ws" });
    await runWithSession("s1", async () => {
      setSessionWorkspace("s1", "ws");

      await addProject.handler(
        addProject.inputSchema.parse({ slug: "agn-rebuild" }),
        await ctxFor("ws"),
      );

      const ingestParsed = ingestContent.inputSchema.parse({
        content: "Decided to rebuild the AGN site on Payload.",
        project: "agn-rebuild",
        type: "decision",
        sourceId: "agn-rebuild-test-1",
        // The metadata contract requires source_url to be a valid URL
        // (z.string().url()); pass one so the pass-through row clears
        // validation and we assert on a real ingest, not the gate alone.
        sourceUrl: "https://example.test/agn-decision",
      });
      const res = await ingestContent.handler(ingestParsed, await ctxFor("ws"));
      expect(res.project).toBe("agn-rebuild");
      expect(res.ingested).toBe(1);
      expect(res.errors ?? []).toHaveLength(0);
    });
  });

  it("ingest_content still rejects a genuinely unknown project", async () => {
    await createWorkspace({ slug: "ws" });
    await runWithSession("s1", async () => {
      setSessionWorkspace("s1", "ws");
      const ingestParsed = ingestContent.inputSchema.parse({
        content: "x",
        project: "ghost-project",
        type: "decision",
        sourceId: "ghost-1",
      });
      await expect(
        ingestContent.handler(ingestParsed, await ctxFor("ws")),
      ).rejects.toThrow(/unknown project 'ghost-project'/i);
    });
  });

  // No-workspace ctx: taxonomy from the empty reader, slug null. The
  // handlers reach requireSessionWorkspace() before touching it.
  async function ctxNoWorkspace(): Promise<ToolContext> {
    return {
      taxonomy: cache.emptyReader(),
      memoryTypes: new MemoryTypeRegistry(),
      logger: silentLogger as never,
      engram,
      sessionWorkspace: null,
      invalidateTaxonomy: (s) => cache.invalidate(s),
    };
  }
});
