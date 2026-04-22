import { defaultTokenPath, readGoogleToken } from "@cortex/google-auth";
import { findRepoRoot, loadDotEnv } from "./dotenv.js";
import { runWizard } from "./wizard-runner.js";
import { findWizard, listWizards, wizardsByCategory } from "./wizard-registry.js";
import {
  applyWizardResult,
  disableModule,
  readModuleConfig,
} from "./config-mutation.js";

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
  process.stdout.write(`\nEnabled "${moduleId}". Run \`cortex sync ${moduleId} --dry-run --limit=5\` to smoke-test.\n`);
  return 0;
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

  const current = await readModuleConfig({ repoRoot }, moduleId);
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
  await disableModule({ repoRoot }, moduleId);
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
    `Usage:\n  cortex add <module>\n  cortex configure <module>\n  cortex disable <module>\n  cortex modules\n\n${formatWizardList()}\n`,
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
