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
        config: { workspace: "acme-co", spaces: ["ExampleCorp"] },
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
    expect(local).toContain("package: \"@onenomad/przm-cortex-adapter-confluence\"");
    expect(local).toContain("enabled: true");
    expect(local).toContain("acme-co");
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

  it("disableModule routes by category for providers (llm.providers.<id>.enabled)", async () => {
    const root = await makeRepo();
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "openrouter",
        category: "provider",
        config: { appTitle: "Cortex", referer: "https://cortex.local", baseUrl: "https://openrouter.ai/api/v1" },
        secrets: { OPENROUTER_API_KEY: "sk-test" },
      },
    );
    await disableModule({ repoRoot: root }, "openrouter", "provider");
    const local = await readFile(
      path.join(root, "config", "cortex.local.yaml"),
      "utf8",
    );
    // The enabled flag under llm.providers.openrouter is now false.
    expect(local).toMatch(/openrouter:\s*\n(?:\s+[^\n]*\n)*?\s+enabled: false/);
    // Config is preserved so re-enabling keeps settings.
    expect(local).toContain("appTitle: Cortex");
  });

  it("disableModule for memory clears memory.fallback but keeps the backend config", async () => {
    const root = await makeRepo();
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "pgvector",
        category: "memory",
        config: { connectionString: "${POSTGRES_URL}", table: "cortex_memories", embeddingDim: 768 },
        secrets: {},
      },
    );
    const beforeLocal = await readFile(
      path.join(root, "config", "cortex.local.yaml"),
      "utf8",
    );
    expect(beforeLocal).toContain("fallback: pgvector");

    await disableModule({ repoRoot: root }, "pgvector", "memory");
    const after = await readFile(
      path.join(root, "config", "cortex.local.yaml"),
      "utf8",
    );
    expect(after).not.toContain("fallback: pgvector");
    // The backend block itself stays so re-enabling doesn't wipe it.
    expect(after).toContain("pgvector:");
    expect(after).toContain("table: cortex_memories");
  });

  it("readModuleConfig with category=provider returns provider config, not undefined", async () => {
    const root = await makeRepo();
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "ollama",
        category: "provider",
        config: { host: "http://localhost:11434", defaultModel: "qwen3:14b" },
        secrets: {},
      },
    );
    // Without the category arg, readModuleConfig would look under
    // `adapters.ollama` and return undefined — which would make
    // `cortex configure ollama` lose all pre-filled defaults.
    const defaulted = await readModuleConfig({ repoRoot: root }, "ollama");
    expect(defaulted).toBeUndefined();
    const correct = await readModuleConfig({ repoRoot: root }, "ollama", "provider");
    expect(correct).toMatchObject({ host: "http://localhost:11434", defaultModel: "qwen3:14b" });
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

  it("provider category writes under llm.providers, not adapters", async () => {
    const root = await makeRepo();
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "openrouter",
        category: "provider",
        config: { appTitle: "Cortex", referer: "https://cortex.local", baseUrl: "https://openrouter.ai/api/v1" },
        secrets: { OPENROUTER_API_KEY: "sk-or-test" },
      },
    );
    const local = await readFile(
      path.join(root, "config", "cortex.local.yaml"),
      "utf8",
    );
    expect(local).toMatch(/llm:\s*\n(?:.*\n)*?\s*providers:\s*\n(?:.*\n)*?\s*openrouter:/);
    expect(local).toContain("package: \"@onenomad/przm-cortex-provider-openrouter\"");
    expect(local).toContain("appTitle: Cortex");
    // Should NOT land under adapters.
    const adaptersMatch = local.match(/^adapters:\s*\n((?:  [^\n]*\n)*)/m);
    expect(adaptersMatch?.[1] ?? "").not.toContain("openrouter");

    const env = await readFile(path.join(root, ".env"), "utf8");
    expect(env).toContain("OPENROUTER_API_KEY=sk-or-test");
  });

  it("memory category sets the named backend block and bumps memory.fallback", async () => {
    const root = await makeRepo();
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "pgvector",
        category: "memory",
        config: {
          connectionString: "${POSTGRES_URL}",
          table: "cortex_memories",
          embeddingDim: 768,
        },
        secrets: { POSTGRES_URL: "postgres://u:p@h:5432/db" },
      },
    );
    const local = await readFile(
      path.join(root, "config", "cortex.local.yaml"),
      "utf8",
    );
    expect(local).toContain("pgvector:");
    expect(local).toContain("fallback: pgvector");
    expect(local).toContain("table: cortex_memories");
    const env = await readFile(path.join(root, ".env"), "utf8");
    expect(env).toContain("POSTGRES_URL=postgres://u:p@h:5432/db");
  });

  it("webhook category merges into the webhooks block", async () => {
    const root = await makeRepo();
    await applyWizardResult(
      { repoRoot: root },
      {
        moduleId: "webhooks",
        category: "webhook",
        config: { enabled: true, host: "0.0.0.0", port: 4040 },
        secrets: {},
      },
    );
    const local = await readFile(
      path.join(root, "config", "cortex.local.yaml"),
      "utf8",
    );
    expect(local).toContain("webhooks:");
    expect(local).toContain("enabled: true");
    expect(local).toContain("port: 4040");
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
    expect(local).toContain("package: \"@onenomad/przm-cortex-adapter-jira\"");
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
