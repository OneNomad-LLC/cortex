import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "@onenomad/cortex-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaxonomyCache } from "../src/taxonomy-cache.js";

function silentLogger(): Logger {
  const noop = () => undefined;
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function capturingLogger(): {
  logger: Logger;
  events: Array<{ level: string; message: string; meta?: Record<string, unknown> }>;
} {
  const events: Array<{
    level: string;
    message: string;
    meta?: Record<string, unknown>;
  }> = [];
  const push = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    events.push({ level, message, ...(meta ? { meta } : {}) });
  };
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => logger,
  };
  return { logger, events };
}

async function seedWorkspace(
  root: string,
  slug: string,
  projects: Array<{ slug: string; name: string }>,
  people: Array<{ slug: string; name: string; email: string }>,
): Promise<void> {
  const cfgDir = path.join(root, slug, "config");
  await mkdir(cfgDir, { recursive: true });
  const projectsYaml =
    projects.length === 0
      ? "projects: []\n"
      : "projects:\n" +
        projects
          .map(
            (p) =>
              `  - slug: ${p.slug}\n    name: "${p.name}"\n    description: ""\n    active: true\n    aliases: []\n    people: []\n    sources: {}\n`,
          )
          .join("");
  const peopleYaml =
    people.length === 0
      ? "people: []\n"
      : "people:\n" +
        people
          .map(
            (p) =>
              `  - slug: ${p.slug}\n    name: "${p.name}"\n    email: ${p.email}\n    projects: []\n    role: ""\n    aliases: []\n`,
          )
          .join("");
  await writeFile(path.join(cfgDir, "projects.yaml"), projectsYaml, "utf8");
  await writeFile(path.join(cfgDir, "people.yaml"), peopleYaml, "utf8");
}

describe("TaxonomyCache", () => {
  let tmp: string;
  let root: string;
  const originalRoot = process.env.CORTEX_WORKSPACES_ROOT;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "cortex-tc-"));
    root = path.join(tmp, "workspaces");
    await mkdir(root, { recursive: true });
    process.env.CORTEX_WORKSPACES_ROOT = root;
  });

  afterEach(async () => {
    if (originalRoot === undefined) delete process.env.CORTEX_WORKSPACES_ROOT;
    else process.env.CORTEX_WORKSPACES_ROOT = originalRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("loads a workspace's taxonomy from disk on first access", async () => {
    await seedWorkspace(
      root,
      "alpha",
      [{ slug: "alpha-one", name: "Alpha One" }],
      [{ slug: "lee", name: "Lee Example", email: "lee@example.com" }],
    );
    const cache = new TaxonomyCache(silentLogger());
    const tx = await cache.forWorkspace("alpha");
    expect(tx.projects).toHaveLength(1);
    expect(tx.projects[0]?.slug).toBe("alpha-one");
    expect(tx.people).toHaveLength(1);
    expect(tx.findPerson("lee")?.slug).toBe("lee");
  });

  it("serves subsequent calls from cache without re-reading disk", async () => {
    await seedWorkspace(
      root,
      "alpha",
      [{ slug: "alpha-one", name: "Alpha One" }],
      [],
    );
    const cache = new TaxonomyCache(silentLogger());
    const first = await cache.forWorkspace("alpha");
    // Mutate the file on disk after the cache is warm.
    await writeFile(
      path.join(root, "alpha", "config", "projects.yaml"),
      "projects: []\n",
      "utf8",
    );
    const second = await cache.forWorkspace("alpha");
    // Still the cached value — no re-read.
    expect(second).toBe(first);
    expect(second.projects).toHaveLength(1);
  });

  it("invalidate forces a reload on next access", async () => {
    await seedWorkspace(
      root,
      "alpha",
      [{ slug: "alpha-one", name: "Alpha One" }],
      [],
    );
    const cache = new TaxonomyCache(silentLogger());
    await cache.forWorkspace("alpha");
    // Mutate the file AND invalidate.
    await writeFile(
      path.join(root, "alpha", "config", "projects.yaml"),
      "projects:\n  - slug: alpha-two\n    name: \"Alpha Two\"\n    description: \"\"\n    active: true\n    aliases: []\n    people: []\n    sources: {}\n",
      "utf8",
    );
    cache.invalidate("alpha");
    const next = await cache.forWorkspace("alpha");
    expect(next.projects[0]?.slug).toBe("alpha-two");
  });

  it("isolates caches per workspace slug", async () => {
    await seedWorkspace(
      root,
      "alpha",
      [{ slug: "alpha-one", name: "Alpha One" }],
      [],
    );
    await seedWorkspace(
      root,
      "beta",
      [{ slug: "beta-one", name: "Beta One" }],
      [],
    );
    const cache = new TaxonomyCache(silentLogger());
    const alpha = await cache.forWorkspace("alpha");
    const beta = await cache.forWorkspace("beta");
    expect(alpha.projects[0]?.slug).toBe("alpha-one");
    expect(beta.projects[0]?.slug).toBe("beta-one");
    expect(cache.size()).toBe(2);
  });

  it("returns an empty reader when the workspace doesn't exist on disk", async () => {
    const { logger, events } = capturingLogger();
    const cache = new TaxonomyCache(logger);
    const tx = await cache.forWorkspace("ghost");
    expect(tx.projects).toEqual([]);
    expect(tx.people).toEqual([]);
    expect(tx.listProjects()).toEqual([]);
    expect(tx.findProject("anything")).toBeUndefined();
    const warned = events.some(
      (e) => e.level === "warn" && e.message === "taxonomy_cache.workspace_missing",
    );
    expect(warned).toBe(true);
  });

  it("empty reader is a shared singleton so the missing path is cheap", async () => {
    const cache = new TaxonomyCache(silentLogger());
    expect(cache.emptyReader()).toBe(cache.emptyReader());
  });

  it("dedupes concurrent loads of the same workspace (single inflight promise)", async () => {
    await seedWorkspace(
      root,
      "alpha",
      [{ slug: "alpha-one", name: "Alpha One" }],
      [],
    );
    const cache = new TaxonomyCache(silentLogger());
    // Kick off multiple concurrent loads — they should all resolve to the
    // same value and leave a single cache entry.
    const [a, b, c] = await Promise.all([
      cache.forWorkspace("alpha"),
      cache.forWorkspace("alpha"),
      cache.forWorkspace("alpha"),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(cache.size()).toBe(1);
  });

  it("invalidateAll clears every cached workspace", async () => {
    await seedWorkspace(root, "alpha", [], []);
    await seedWorkspace(root, "beta", [], []);
    const cache = new TaxonomyCache(silentLogger());
    await cache.forWorkspace("alpha");
    await cache.forWorkspace("beta");
    expect(cache.size()).toBe(2);
    cache.invalidateAll();
    expect(cache.size()).toBe(0);
  });

  it("invalidate on an unknown slug is a no-op (doesn't throw)", () => {
    const cache = new TaxonomyCache(silentLogger());
    expect(() => cache.invalidate("never-loaded")).not.toThrow();
  });
});
