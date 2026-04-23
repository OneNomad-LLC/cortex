import path from "node:path";
import { confirm, select } from "@inquirer/prompts";
import { defaultTokenPath, readGoogleToken } from "@onenomad/cortex-google-auth";
import {
  discoverProjectCandidates,
  loadCurrentConfig,
  type DiscoveredCandidate,
} from "./discovery.js";
import { findRepoRoot, loadDotEnv } from "./dotenv.js";
import {
  pickAndRefineCandidates,
  runProjectsWizard,
} from "./projects-wizard.js";
import { resolveConfigPath } from "./config-path.js";
import { runWizard } from "./wizard-runner.js";
import { findWizard, listWizards, wizardsByCategory } from "./wizard-registry.js";
import {
  applyWizardResult,
  disableModule,
  ensureLocalCopy,
  mergeProjects,
  readModuleConfig,
} from "./config-mutation.js";
import { createLogger } from "../logger.js";

const GOOGLE_MODULES = new Set(["gmail", "google-calendar", "google-drive"]);

/**
 * `cortex add <module>` — runs a single module's wizard and merges the
 * result into config/cortex.local.yaml + .env + config/projects.local.yaml.
 */
export async function runAdd(args: readonly string[]): Promise<number> {
  const moduleId = args[0];
  if (!moduleId) {
    printUsage();
    return 2;
  }
  // Special-case taxonomy wizards — they don't configure a module, they
  // populate projects.yaml / people.yaml via runtime discovery.
  if (moduleId === "projects") return runProjectsWizard(args.slice(1));
  const wizard = findWizard(moduleId);
  if (!wizard) {
    process.stderr.write(
      `cortex add: no wizard for "${moduleId}". Available:\n${formatWizardList()}\n`,
    );
    return 2;
  }
  if (!process.stdin.isTTY) {
    process.stderr.write("cortex add: interactive wizard requires a TTY.\n");
    return 2;
  }
  const repoRoot = findRepoRoot(process.cwd());
  loadDotEnv(repoRoot);

  if (GOOGLE_MODULES.has(moduleId)) {
    const ok = await ensureGoogleToken(moduleId);
    if (!ok) return 2;
  }

  const result = await runWizard(wizard);
  const { filesWritten } = await applyWizardResult({ repoRoot }, result);
  process.stdout.write(
    `\nSaved:\n${filesWritten.map((f) => `  ${f}`).join("\n")}\n`,
  );
  process.stdout.write(`\nEnabled "${moduleId}".`);

  // Post-install project import — only if the adapter has a discovery
  // hook. Silently skips for everything else.
  await offerProjectImport({ moduleId, repoRoot });

  process.stdout.write(
    `\nRun \`cortex sync ${moduleId} --dry-run --limit=5\` to smoke-test.\n`,
  );
  return 0;
}

/**
 * After an adapter wizard finishes, if the adapter implements
 * `discoverProjects`, offer to import what it found into
 * `projects.local.yaml`. Three-way choice: Add all, Pick some, Skip.
 *
 * Runs live — instantiates the adapter with the just-written config
 * and calls `discoverProjects`. Failures are logged, not fatal; the
 * user can always re-run `cortex add projects` later.
 */
async function offerProjectImport(args: {
  moduleId: string;
  repoRoot: string;
}): Promise<void> {
  const { moduleId, repoRoot } = args;
  const configPath = resolveConfigPath();
  const cfg = await loadCurrentConfig(configPath);
  if (!cfg) return;
  const entry = cfg.adapters[moduleId];
  if (!entry?.enabled) return;

  const logger = createLogger({ component: "post-install-discovery" });
  process.stdout.write("\nScanning for project candidates...\n");
  const result = await discoverProjectCandidates({
    cfg,
    repoRoot,
    logger,
    adapterIds: [moduleId],
  });
  const adapterRow = result.perAdapter.find((r) => r.adapterId === moduleId);
  if (!adapterRow) return;
  if (adapterRow.status === "no-discovery") {
    // Adapter doesn't support discovery — nothing to offer.
    return;
  }
  if (adapterRow.status === "failed") {
    process.stdout.write(
      `  Couldn't auto-discover from ${moduleId}: ${adapterRow.error ?? "unknown"}\n` +
        `  You can still run \`cortex add projects\` to add them manually.\n`,
    );
    return;
  }
  const candidates = result.candidates;
  if (candidates.length === 0) {
    process.stdout.write(`  No projects found in ${moduleId}.\n`);
    return;
  }

  process.stdout.write(
    `\nFound ${candidates.length} project candidate${candidates.length === 1 ? "" : "s"} in ${moduleId}.\n`,
  );
  const choice = await select<"all" | "pick" | "skip">({
    message: "Import them?",
    choices: [
      { value: "all", name: `Add all ${candidates.length}` },
      { value: "pick", name: "Let me pick some" },
      { value: "skip", name: "Skip — I'll run `cortex add projects` later" },
    ],
    default: "all",
  });

  let picked: DiscoveredCandidate[];
  if (choice === "skip") return;
  if (choice === "all") {
    picked = candidates;
  } else {
    picked = await pickAndRefineCandidates(candidates);
  }
  if (picked.length === 0) return;

  const projectsPath = await ensureLocalCopy(
    path.join(repoRoot, "config", "projects.yaml"),
  );
  await mergeProjects(
    projectsPath,
    picked.map((c) => ({
      slug: c.slug,
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      ...(c.sources && Object.keys(c.sources).length > 0
        ? { sources: c.sources }
        : {}),
    })),
  );
  process.stdout.write(
    `\nAdded ${picked.length} project${picked.length === 1 ? "" : "s"} to ${projectsPath}:\n` +
      `  ${picked.map((c) => c.slug).join("\n  ")}\n`,
  );
  // Confirm to keep going — useful if the user wants to review the
  // YAML before moving on. Declining doesn't undo the write; it just
  // pauses so the message is readable.
  await confirm({
    message: "Continue?",
    default: true,
  }).catch(() => undefined);
}

/**
 * `cortex configure <module>` — re-runs the wizard with current values
 * as defaults. For updates after the initial add.
 */
export async function runConfigure(args: readonly string[]): Promise<number> {
  const moduleId = args[0];
  if (!moduleId) {
    printUsage();
    return 2;
  }
  const wizard = findWizard(moduleId);
  if (!wizard) {
    process.stderr.write(`cortex configure: no wizard for "${moduleId}".\n`);
    return 2;
  }
  if (!process.stdin.isTTY) {
    process.stderr.write("cortex configure: interactive wizard requires a TTY.\n");
    return 2;
  }
  const repoRoot = findRepoRoot(process.cwd());
  loadDotEnv(repoRoot);

  // Read using the wizard's declared category — otherwise non-adapter
  // modules (providers, memory, webhooks) would miss their current values
  // because readModuleConfig would look under `adapters.<id>` by default.
  const current = await readModuleConfig({ repoRoot }, moduleId, wizard.category);
  const result = await runWizard(wizard, {
    ...(current ? { currentValues: current } : {}),
    // Current secrets pulled from process.env after loadDotEnv.
    currentSecrets: Object.fromEntries(
      (wizard.secrets ?? []).map((s) => [s.envVar, process.env[s.envVar] ?? ""]),
    ),
  });
  const { filesWritten } = await applyWizardResult({ repoRoot }, result);
  process.stdout.write(
    `\nUpdated:\n${filesWritten.map((f) => `  ${f}`).join("\n")}\n`,
  );
  return 0;
}

/**
 * `cortex disable <module>` — flips enabled: false. Leaves config in
 * place so re-enabling via `cortex add` keeps the settings.
 */
export async function runDisable(args: readonly string[]): Promise<number> {
  const moduleId = args[0];
  if (!moduleId) {
    printUsage();
    return 2;
  }
  const repoRoot = findRepoRoot(process.cwd());
  // Look up the category so non-adapter modules (providers, memory,
  // webhooks) disable in the right YAML section.
  const wizard = findWizard(moduleId);
  await disableModule({ repoRoot }, moduleId, wizard?.category);
  process.stdout.write(`Disabled "${moduleId}" in config/cortex.local.yaml.\n`);
  return 0;
}

/**
 * `cortex modules` — list available wizards grouped by category.
 */
export async function runList(): Promise<number> {
  const byCat = wizardsByCategory();
  if (byCat.size === 0) {
    process.stdout.write("No module wizards registered yet.\n");
    return 0;
  }
  for (const [category, mods] of byCat) {
    process.stdout.write(`\n${category}s:\n`);
    for (const m of mods) {
      process.stdout.write(`  ${m.id.padEnd(20)}  ${m.description}\n`);
    }
  }
  return 0;
}

function printUsage(): void {
  process.stderr.write(
    `Usage:\n` +
      `  cortex add projects      # auto-discover + add projects\n` +
      `  cortex add <module>      # enable an adapter/provider via wizard\n` +
      `  cortex configure <module>\n` +
      `  cortex disable <module>\n` +
      `  cortex modules\n\n${formatWizardList()}\n`,
  );
}

function formatWizardList(): string {
  return (
    "Available module wizards:\n" +
    listWizards()
      .map((w) => `  ${w.id} — ${w.name}`)
      .join("\n")
  );
}

/**
 * Gmail / Calendar / Drive all need the shared Google refresh token. Rather
 * than silently fail at boot, check up front and point the user at the
 * login subcommand if it's missing or lacks the right scope.
 */
async function ensureGoogleToken(moduleId: string): Promise<boolean> {
  const tokenPath = defaultTokenPath();
  try {
    const token = await readGoogleToken(tokenPath);
    const required = SCOPES_FOR_MODULE[moduleId];
    if (required && !required.every((s) => token.scopes.includes(s))) {
      process.stderr.write(
        `cortex add ${moduleId}: the Google token at ${tokenPath} is missing\n` +
          `required scope(s): ${required.filter((s) => !token.scopes.includes(s)).join(", ")}\n` +
          `Re-run \`cortex google-login\` and include "${moduleId}" in the service picker.\n`,
      );
      return false;
    }
    return true;
  } catch {
    process.stderr.write(
      `cortex add ${moduleId}: no Google token at ${tokenPath}.\n` +
        `Run \`cortex google-login\` first, then re-run this command.\n`,
    );
    return false;
  }
}

const SCOPES_FOR_MODULE: Record<string, readonly string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  "google-calendar": ["https://www.googleapis.com/auth/calendar.readonly"],
  "google-drive": ["https://www.googleapis.com/auth/drive.readonly"],
};
