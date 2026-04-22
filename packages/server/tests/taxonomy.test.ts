import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTaxonomy } from "../src/taxonomy.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function load() {
  return loadTaxonomy({
    projectsPath: path.join(fixturesDir, "projects.yaml"),
    peoplePath: path.join(fixturesDir, "people.yaml"),
  });
}

describe("loadTaxonomy", () => {
  it("reads the fixture files", async () => {
    const tx = await load();
    expect(tx.projects).toHaveLength(3);
    expect(tx.people).toHaveLength(2);
  });

  it("activeOnly filters out legacy projects", async () => {
    const tx = await load();
    const active = tx.listProjects({ activeOnly: true });
    expect(active.map((p) => p.slug)).toEqual(["project-alpha", "project-beta"]);
    const all = tx.listProjects();
    expect(all).toHaveLength(3);
  });

  it("findProject resolves slug, alias, and normalized alias", async () => {
    const tx = await load();
    expect(tx.findProject("project-alpha")?.slug).toBe("project-alpha");
    expect(tx.findProject("Alpha")?.slug).toBe("project-alpha");
    expect(tx.findProject("proj a")?.slug).toBe("project-alpha");
    expect(tx.findProject("Project Beta")?.slug).toBe("project-beta");
    expect(tx.findProject("nope")).toBeUndefined();
  });

  it("findPerson resolves slug, email (case-insensitive), name, and alias", async () => {
    const tx = await load();
    expect(tx.findPerson("alex")?.slug).toBe("alex");
    expect(tx.findPerson("sarah.example@company.com")?.slug).toBe("sarah");
    expect(tx.findPerson("Alexander")?.slug).toBe("alex");
    expect(tx.findPerson("Sarah Example")?.slug).toBe("sarah");
    expect(tx.findPerson("unknown")).toBeUndefined();
  });

  it("returns empty taxonomy when files are missing", async () => {
    const tx = await loadTaxonomy({
      projectsPath: path.join(fixturesDir, "does-not-exist.yaml"),
      peoplePath: path.join(fixturesDir, "also-missing.yaml"),
    });
    expect(tx.projects).toEqual([]);
    expect(tx.people).toEqual([]);
    expect(tx.listProjects()).toEqual([]);
  });
});
