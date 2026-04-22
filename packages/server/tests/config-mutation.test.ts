import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyWizardResult,
  disableModule,
  readModuleConfig,
} from "../src/cli/config-mutation.js";

const roots: string[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) {
    await rm(r, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-cfg-"));
  roots.push(root);
  await mkdir(path.join(root, "config"), { recursive: true });
  // Minimal cortex.yaml template — loader should copy this to cortex.local.yaml
  // on first mutation.
  await writeFile(
    path.join(root, "config", "cortex.yaml"),
    "llm:\n  providers: {}\n  tasks:\n    default: { provider: ollama, model: x }\nadapters: {}\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "config", "projects.yaml"),
    "projects: []\n",
    "utf8",
  );
  return root;
}

describe("config-mutation", () => {
  it("applyWizardResult creates cortex.local.yaml from template and writes adapter block", async () => {
    const root = await makeRepo();
    const out = await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "confluence",
        config: { workspace: "elevate-digital", spaces: ["DrivenBrands"] },
        secrets: {},
      },
    );
    expect(out.filesWritten.some((p) => p.endsWith("cortex.local.yaml"))).toBe(
      true,
    );

    const local = await readFile(
      path.join(root, "config", "cortex.local.yaml"),
      "utf8",
    );
    expect(local).toContain("confluence:");
    expect(local).toContain("package: \"@cortex/adapter-confluence\"");
    expect(local).toContain("enabled: true");
    expect(local).toContain("elevate-digital");
  });

  it("merges secrets into .env, creating it if absent", async () => {
    const root = await makeRepo();
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "confluence",
        config: { workspace: "wc", spaces: [] },
        secrets: { ATLASSIAN_EMAIL: "you@example.com", ATLASSIAN_API_TOKEN: "t" },
      },
    );
    const env = await readFile(path.join(root, ".env"), "utf8");
    expect(env).toContain("ATLASSIAN_EMAIL=you@example.com");
    expect(env).toContain("ATLASSIAN_API_TOKEN=t");
  });

  it("updates an existing env key in place instead of appending", async () => {
    const root = await makeRepo();
    await writeFile(
      path.join(root, ".env"),
      "ATLASSIAN_EMAIL=old@example.com\nOTHER=keep\n",
      "utf8",
    );
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "confluence",
        config: { workspace: "w", spaces: [] },
        secrets: { ATLASSIAN_EMAIL: "new@example.com" },
      },
    );
    const env = await readFile(path.join(root, ".env"), "utf8");
    expect(env).toContain("ATLASSIAN_EMAIL=new@example.com");
    expect(env).not.toContain("old@example.com");
    expect(env).toContain("OTHER=keep");
  });

  it("writes derived projects into projects.local.yaml without duplicating", async () => {
    const root = await makeRepo();
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "confluence",
        config: { workspace: "w", spaces: [] },
        secrets: {},
        derivedTaxonomy: {
          projects: [{ slug: "alpha" }, { slug: "beta", name: "Beta" }],
        },
      },
    );
    // Second run with one new + one existing — should not duplicate alpha.
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "confluence",
        config: { workspace: "w", spaces: [] },
        secrets: {},
        derivedTaxonomy: {
          projects: [{ slug: "alpha" }, { slug: "gamma" }],
        },
      },
    );
    const projects = await readFile(
      path.join(root, "config", "projects.local.yaml"),
      "utf8",
    );
    expect(projects.match(/slug: alpha/g)?.length ?? 0).toBe(1);
    expect(projects).toContain("slug: beta");
    expect(projects).toContain("slug: gamma");
  });

  it("disableModule flips enabled: false and leaves config in place", async () => {
    const root = await makeRepo();
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "confluence",
        config: { workspace: "preserve-me" },
        secrets: {},
      },
    );
    await disableModule({ repoRoot: root }, "confluence");
    const local = await readFile(
      path.join(root, "config", "cortex.local.yaml"),
      "utf8",
    );
    expect(local).toContain("enabled: false");
    expect(local).toContain("preserve-me");
  });

  it("readModuleConfig returns the current config for `cortex configure`", async () => {
    const root = await makeRepo();
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "confluence",
        config: { workspace: "read-me", spaces: ["A", "B"] },
        secrets: {},
      },
    );
    const cfg = await readModuleConfig({ repoRoot: root }, "confluence");
    expect(cfg).toMatchObject({ workspace: "read-me", spaces: ["A", "B"] });
  });

  it("jira wizard result lands under its own adapter block alongside confluence", async () => {
    const root = await makeRepo();
    // Enable confluence first.
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "confluence",
        config: { workspace: "acme", spaces: ["ENG"] },
        secrets: { ATLASSIAN_EMAIL: "you@example.com", ATLASSIAN_API_TOKEN: "t" },
      },
    );
    // Then jira — shares ATLASSIAN_* secrets; the .env merge must not duplicate them.
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "jira",
        config: {
          workspace: "acme",
          projects: ["ENG", "OPS"],
          projectKeyToContext: {
            ENG: { project: "alpha", engagement: "acme-corp" },
            OPS: { project: "beta" },
          },
        },
        secrets: { ATLASSIAN_EMAIL: "you@example.com", ATLASSIAN_API_TOKEN: "t" },
        derivedTaxonomy: {
          projects: [{ slug: "alpha" }, { slug: "beta" }],
        },
      },
    );
    const local = await readFile(
      path.join(root, "config", "cortex.local.yaml"),
      "utf8",
    );
    expect(local).toContain("confluence:");
    expect(local).toContain("jira:");
    expect(local).toContain("package: \"@cortex/adapter-jira\"");
    expect(local).toContain("ENG");
    expect(local).toContain("OPS");

    // .env should have one entry each, not duplicates from the shared creds.
    const env = await readFile(path.join(root, ".env"), "utf8");
    expect(env.match(/^ATLASSIAN_EMAIL=/gm)?.length ?? 0).toBe(1);
    expect(env.match(/^ATLASSIAN_API_TOKEN=/gm)?.length ?? 0).toBe(1);

    // Derived projects should include both alpha and beta, from both wizards.
    const projects = await readFile(
      path.join(root, "config", "projects.local.yaml"),
      "utf8",
    );
    expect(projects).toContain("slug: alpha");
    expect(projects).toContain("slug: beta");
  });
});
