import { mkdtemp, mkdir, writeFile, rm, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeInputsSha } from "../src/sha.js";

const FIXTURE_REPO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fixture-repo",
);

/** Copy the fixture to a temp dir so each test can mutate freely. */
async function cloneFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cdd-sha-"));
  await cp(FIXTURE_REPO, dir, { recursive: true });
  return dir;
}

describe("computeInputsSha", () => {
  let workdirs: string[] = [];

  beforeAll(() => {
    workdirs = [];
  });
  afterAll(async () => {
    for (const d of workdirs) {
      await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function fresh(): Promise<string> {
    const d = await cloneFixture();
    workdirs.push(d);
    return d;
  }

  it("is deterministic across runs against the same repo", async () => {
    const dir = await fresh();
    const input = { repoPath: dir, sourceIdPrefix: "github:o/w" };
    const a = await computeInputsSha(input);
    const b = await computeInputsSha(input);
    expect(a).toEqual(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does NOT change when an irrelevant file is added/edited", async () => {
    const dir = await fresh();
    const input = { repoPath: dir, sourceIdPrefix: "github:o/w" };
    const before = await computeInputsSha(input);

    // Touch a file that isn't on the structural-inputs list.
    await writeFile(
      path.join(dir, "irrelevant.txt"),
      "this file is not consulted by the dossier pipeline\n",
      "utf8",
    );
    // Also a nested file the pipeline never reads.
    await mkdir(path.join(dir, "deep", "nested"), { recursive: true });
    await writeFile(
      path.join(dir, "deep", "nested", "thing.txt"),
      "still irrelevant\n",
      "utf8",
    );

    const after = await computeInputsSha(input);
    expect(after).toEqual(before);
  });

  it("changes when the README content changes", async () => {
    const dir = await fresh();
    const input = { repoPath: dir, sourceIdPrefix: "github:o/w" };
    const before = await computeInputsSha(input);

    const readmePath = path.join(dir, "README.md");
    const original = await readFile(readmePath, "utf8");
    await writeFile(readmePath, original + "\n\n## New section\n", "utf8");

    const after = await computeInputsSha(input);
    expect(after).not.toEqual(before);
  });

  it("changes when a new ADR is added", async () => {
    const dir = await fresh();
    const input = { repoPath: dir, sourceIdPrefix: "github:o/w" };
    const before = await computeInputsSha(input);

    await writeFile(
      path.join(dir, "docs", "ADR-002.md"),
      "# ADR-002 — A second decision\n\nDecided: this.\n",
      "utf8",
    );

    const after = await computeInputsSha(input);
    expect(after).not.toEqual(before);
  });

  it("changes when an entry-point file content changes", async () => {
    const dir = await fresh();
    const input = { repoPath: dir, sourceIdPrefix: "github:o/w" };
    const before = await computeInputsSha(input);

    const indexPath = path.join(dir, "src", "index.ts");
    const original = await readFile(indexPath, "utf8");
    await writeFile(indexPath, original + "\n// added comment\n", "utf8");

    const after = await computeInputsSha(input);
    expect(after).not.toEqual(before);
  });

  it("is insensitive to the absolute repo path (so caches survive relocation)", async () => {
    const a = await fresh();
    const b = await fresh();
    const inputA = { repoPath: a, sourceIdPrefix: "github:o/w" };
    const inputB = { repoPath: b, sourceIdPrefix: "github:o/w" };
    const shaA = await computeInputsSha(inputA);
    const shaB = await computeInputsSha(inputB);
    expect(shaA).toEqual(shaB);
  });
});
