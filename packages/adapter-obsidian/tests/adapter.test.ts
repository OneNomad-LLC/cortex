import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@onenomad/przm-cortex-core";
import { ObsidianAdapter } from "../src/adapter.js";

const tempRoots: string[] = [];

afterEach(async () => {
  // Best-effort cleanup. Leaving temp dirs around if we crash is fine —
  // the OS handles it.
  const { rm } = await import("node:fs/promises");
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeVault(
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-obsidian-"));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

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
    secrets: {},
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

describe("ObsidianAdapter", () => {
  it("walks the vault, skips ignored dirs, and yields markdown files", async () => {
    const vault = await makeVault({
      "work/alpha/note.md": "# Alpha plan\n\nShip v2.",
      "work/beta/idea.md": "# Beta idea\n\nNotes here.",
      ".obsidian/config.md": "# internal",
      ".trash/old.md": "# trashed",
      "attachments/photo.png": "not a note",
    });

    const adapter = new ObsidianAdapter();
    await adapter.init(
      makeCtx({
        vaultPath: vault,
        pathToProject: [
          { prefix: "work/alpha/", project: "project-alpha" },
          { prefix: "work/beta/", project: "project-beta" },
        ],
      }),
    );

    const items = [];
    for await (const raw of adapter.fetch()) {
      items.push(raw);
    }
    const paths = items
      .map((r) => ((r.raw as { relativePath: string }).relativePath))
      .sort();
    expect(paths).toEqual(["work/alpha/note.md", "work/beta/idea.md"]);
  });

  it("transform extracts frontmatter and title", async () => {
    const vault = await makeVault({
      "work/alpha/onboarding.md": [
        "---",
        'title: "Alpha Onboarding"',
        "tags: [onboarding, alpha]",
        "---",
        "",
        "Welcome.",
      ].join("\n"),
    });

    const adapter = new ObsidianAdapter();
    await adapter.init(
      makeCtx({
        vaultPath: vault,
        pathToProject: [{ prefix: "work/alpha/", project: "project-alpha" }],
      }),
    );

    const items = [];
    for await (const raw of adapter.fetch()) {
      items.push(raw);
    }
    expect(items).toHaveLength(1);
    const normalized = await adapter.transform(items[0]!);
    expect(normalized.title).toBe("Alpha Onboarding");
    expect(normalized.contentType).toBe("note");
    expect(normalized.content.trim()).toBe("Welcome.");
    expect(normalized.rawMetadata.relativePath).toBe("work/alpha/onboarding.md");
  });

  it("classify honours frontmatter `project` over path rules", async () => {
    const adapter = new ObsidianAdapter();
    await adapter.init(makeCtx({ vaultPath: "/nonexistent" }));

    const classified = await adapter.classify(
      {
        sourceId: "x",
        sourceType: "obsidian",
        sourceUrl: "file:///x",
        title: "t",
        content: "c",
        contentType: "note",
        createdAt: new Date(),
        updatedAt: new Date(),
        authors: [],
        rawMetadata: {
          relativePath: "work/alpha/note.md",
          frontmatter: { project: "override-slug" },
        },
      },
      {},
    );
    expect(classified.projects).toEqual(["override-slug"]);
    expect(classified.classificationMethod).toBe("manual");
  });

  it("classify falls through to path rule when no frontmatter", async () => {
    const adapter = new ObsidianAdapter();
    await adapter.init(
      makeCtx({
        vaultPath: "/nonexistent",
        pathToProject: [{ prefix: "work/alpha/", project: "project-alpha" }],
      }),
    );

    const classified = await adapter.classify(
      {
        sourceId: "x",
        sourceType: "obsidian",
        sourceUrl: "file:///x",
        title: "t",
        content: "c",
        contentType: "note",
        createdAt: new Date(),
        updatedAt: new Date(),
        authors: [],
        rawMetadata: { relativePath: "work/alpha/note.md", frontmatter: {} },
      },
      {},
    );
    expect(classified.projects).toEqual(["project-alpha"]);
    expect(classified.classificationMethod).toBe("path-based");
  });
});
