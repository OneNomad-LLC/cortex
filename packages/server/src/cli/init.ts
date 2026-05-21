import { existsSync } from "node:fs";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  checkbox,
  confirm,
  input,
  password,
  select,
} from "@inquirer/prompts";
import { openBrowser } from "./open-browser.js";
import { findRepoRoot, loadDotEnv } from "./dotenv.js";
import {
  detectOllama,
  installOllama,
  ollamaHasModel,
  ollamaPullModel,
  waitForOllama,
} from "./detect.js";
import { writeConfig, type ProviderChoice } from "./write-config.js";
import { runSmoke } from "./smoke.js";
import { applyWizardResult } from "./config-mutation.js";
import { runWizard } from "./wizard-runner.js";
import { listWizards, wizardsByCategory } from "./wizard-registry.js";
import {
  createWorkspace,
  findWorkspace,
  getActiveWorkspace,
  switchWorkspace,
  validateSlug,
} from "./workspace/manager.js";

export interface InitArgs {
  args: readonly string[];
}

export async function runInit(args: InitArgs): Promise<number> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "przm-cortex init: interactive wizard requires a TTY. " +
        "Run from a real terminal.\n",
    );
    return 2;
  }

  const repoRoot = findRepoRoot(process.cwd());
  header("przm-cortex setup");

  // -1. Pick setup surface — terminal or browser. Users with a
  //     preference pass `--cli` / `--web` so they don't see the prompt.
  const mode = await pickSetupMode(args.args);

  if (mode === "web") {
    return runWebSetup(repoRoot);
  }

  // 0. Workspace selection — every install gets at least one workspace
  //    so config + .env + memory state are isolated from any other
  //    context the user may want to manage later.
  const writeRoot = await stepWorkspace(repoRoot);

  // 1. (Removed) Engram + Persona pre-flight — cortex 0.3 dropped those
  //    runtime dependencies (ADR-012). detectDeps() returns [] today;
  //    if a future companion service is added, plug a check in here.

  // 2. Provider selection + config
  const providers = await stepProviders();

  // 2a. If Ollama selected on a local host, make sure the bin is installed
  //     and the chosen model is pulled.
  await stepOllamaLocal(providers);

  // 3. Secrets
  const secrets = await stepSecrets(providers);

  // 4. Default task binding
  const defaultTask = await stepDefaultTask(providers);

  // 5. Write files — goes into the active workspace's directory if one
  //    was selected in step 0, otherwise falls back to the repo root.
  const result = await writeConfig({
    repoRoot: writeRoot,
    providers,
    defaultTask,
    secrets,
  });

  section("Wrote");
  line(`  ${result.envPath}`);
  line(`  ${result.configPath}`);
  if (result.envBackupPath) {
    line(`  (previous .env backed up to ${result.envBackupPath})`);
  }
  if (result.configBackupPath) {
    line(`  (previous cortex.yaml backed up to ${result.configBackupPath})`);
  }

  // 5a. Source adapter selection + per-module wizards. Each enabled module
  //     writes to config/cortex.local.yaml (and .env + projects.local.yaml
  //     as needed) via the shared config-mutation service.
  await stepAdapters(writeRoot);

  // 6. Optional smoke test
  const shouldSmoke = await confirm({
    message: "Run a live LLM smoke test now?",
    default: true,
  });

  if (shouldSmoke) {
    section("Smoke test");
    process.env.PRZM_CORTEX_CONFIG_PATH = result.configPath;
    // Propagate the secrets we just collected directly into the current
    // process environment. loadDotEnv alone isn't enough — a parent shell
    // may already have these vars set to empty, which makes loadDotEnv skip
    // them and leaves `${VAR}` references in cortex.yaml unexpanded.
    for (const [k, v] of Object.entries(secrets)) {
      if (v) process.env[k] = v;
    }
    loadDotEnv(result.envPath);
    const code = await runSmoke();
    if (code !== 0) {
      warn(
        "Smoke test reported failures. Check the logs above; re-run " +
          "`przm-cortex smoke` after fixing config.",
      );
      return code;
    }
  }

  section("Next steps");
  line("  - Add a data source adapter:  `przm-cortex add notion`  (or github, slack, etc.)");
  line(`  - Edit ${path.join(writeRoot, "config", "cortex.yaml")} for backend / provider tuning`);
  line("  - Ingest your first doc / URL / repo:");
  line("      `przm-cortex ingest file <path>`  /  `ingest url <url>`  /  `ingest repo <path>`");
  line("  - Wire Cortex into your MCP client (Claude Code / Pyre / etc.):");
  line(
    '      { "mcpServers": { "przm-cortex": { "command": "przm-cortex", "args": ["start"] } } }',
  );
  line("  - Run `przm-cortex start` directly for debugging");
  line("  - Launch the dashboard with `przm-cortex dashboard` (needs api.enabled: true)");
  line("");
  return 0;
}

/**
 * Pick (or create) the workspace that subsequent steps will write into.
 *
 * Returns the "root" path where config/ and .env live. For workspace
 * users, that's `~/.cortex/workspaces/<slug>/`. For legacy setups
 * (user declined to create a workspace), it falls back to the repo
 * root so the old behavior still works.
 */
async function stepWorkspace(repoRoot: string): Promise<string> {
  section("Workspace");

  const active = await getActiveWorkspace();
  if (active) {
    ok(`using active workspace '${active.slug}'`);
    line(`  ${active.path}`);
    return active.path;
  }

  line(
    "  A workspace is an isolated bundle of config + .env + memory state.\n" +
      "  Create one per job, client, or personal context. Switch between\n" +
      "  them any time with `przm-cortex workspace switch <slug>`.",
  );

  const createOne = await confirm({
    message: "Create a workspace now?",
    default: true,
  });
  if (!createOne) {
    warn(
      "Skipping — init will write to the repo's ./config and .env instead. " +
        "You can migrate later with `przm-cortex workspace add <slug> --from .`.",
    );
    return repoRoot;
  }

  const slug = await input({
    message: "Workspace slug (kebab-case — e.g. onenomad, acme, personal)",
    validate: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return "required";
      const check = validateSlug(trimmed);
      return check.ok ? true : check.reason;
    },
  });
  const clean = slug.trim();

  const existing = await findWorkspace(clean);
  if (existing) {
    const overwrite = await confirm({
      message: `Workspace '${clean}' already exists at ${existing.path}. Use it?`,
      default: true,
    });
    if (!overwrite) {
      warn("Skipped — pick a different slug and re-run `przm-cortex init`.");
      return repoRoot;
    }
    await switchWorkspace(clean);
    ok(`activated existing workspace '${clean}'`);
    return existing.path;
  }

  // Offer to seed from the repo's current config so users migrating
  // away from single-config setups keep their existing adapter + LLM
  // choices. Only ask if there actually IS a config to copy — if the
  // user ran init from outside any cortex checkout, the copy would
  // silently do nothing and the prompt is just noise.
  const repoHasConfig =
    repoRoot && existsSync(path.join(repoRoot, "config", "cortex.yaml"));
  const seedFromRepo =
    repoHasConfig &&
    (await confirm({
      message: `Copy config + .env from ${repoRoot} into '${clean}'?`,
      default: true,
    }));

  const ws = await createWorkspace({
    slug: clean,
    ...(seedFromRepo ? { fromPath: repoRoot } : {}),
  });
  await switchWorkspace(clean);
  ok(`created workspace '${clean}' (active)`);
  line(`  ${ws.path}`);
  if (seedFromRepo) line(`  seeded from ${repoRoot}`);
  return ws.path;
}

// stepDependencies removed in cortex 0.4. Pre-cortex-0.3 it probed for
// Engram + Persona companion MCP binaries; ADR-012 made cortex
// standalone. detectDeps() is preserved in cli/detect.ts as an
// extension point for any future runtime companion.

async function stepProviders(): Promise<ProviderChoice[]> {
  section("LLM providers");
  const selected = await checkbox({
    message: "Which LLM providers will Cortex use?",
    choices: [
      // OpenRouter is the default: BYOK cloud aggregator, no GPU required,
      // works on a VPS. Ollama is the opt-in path for users with a GPU
      // box (the author's original setup) who prefer local inference.
      { name: "OpenRouter (cloud BYOK)", value: "openrouter", checked: true },
      { name: "Ollama (local)", value: "ollama" },
    ],
    required: true,
  });

  const providers: ProviderChoice[] = [];

  if (selected.includes("ollama")) {
    const host = await input({
      message: "Ollama host",
      default: process.env.OLLAMA_HOST ?? "http://localhost:11434",
      validate: validateOllamaHost,
    });
    const defaultModel = await input({
      message: "Default Ollama model",
      default: "qwen3:14b",
    });
    providers.push({
      id: "ollama",
      enabled: true,
      settings: { host, defaultModel },
    });
  }

  if (selected.includes("openrouter")) {
    providers.push({
      id: "openrouter",
      enabled: true,
      settings: {},
    });
  }

  return providers;
}

async function stepOllamaLocal(providers: ProviderChoice[]): Promise<void> {
  const ollama = providers.find((p) => p.id === "ollama");
  if (!ollama || !ollama.enabled) return;

  const host = ollama.settings.host ?? "http://localhost:11434";
  const model = ollama.settings.defaultModel ?? "qwen3:14b";
  if (!isLocalHost(host)) {
    // Remote Ollama (Tailscale, VPS). Nothing to install locally; just
    // confirm reachability.
    section("Ollama (remote)");
    line(`  host: ${host}`);
    const reachable = await waitForOllama(host, { timeoutMs: 5_000 });
    if (reachable) ok("reachable");
    else warn("not reachable yet — make sure the remote host is running");
    return;
  }

  section("Ollama (local)");
  const status = await detectOllama();

  if (status.installed) {
    ok(`ollama installed${status.version ? ` (${status.version})` : ""}${status.path ? ` at ${status.path}` : ""}`);
  } else {
    miss("ollama not found on PATH");
    const doInstall = await confirm({
      message: "Install Ollama now?",
      default: true,
    });
    if (!doInstall) {
      warn("Skipped. Install manually from https://ollama.com/download then re-run `przm-cortex init`.");
      return;
    }
    const code = await installOllama();
    if (code !== 0) {
      warn(`Installer exited with ${code}. Continuing — model pull will be skipped.`);
      return;
    }
    const after = await detectOllama();
    if (after.installed) ok("ollama installed");
    else {
      warn("ollama still not on PATH after install (shell restart may be required).");
      return;
    }
  }

  // Wait for the daemon to respond before probing for the model. 10s is
  // plenty when the daemon is running locally; longer just hides typos.
  const up = await waitForOllama(host, { timeoutMs: 10_000 });
  if (!up) {
    warn(
      `Ollama didn't respond at ${host} within 10s. ` +
        `Common causes: typo in host (Ollama is http://, not https://), ` +
        `firewall blocking 11434, or \`ollama serve\` not running.`,
    );
    return;
  }
  ok(`ollama daemon responding at ${host}`);

  // Model presence
  const has = await ollamaHasModel(host, model);
  if (has === true) {
    ok(`model '${model}' already pulled`);
    return;
  }
  if (has === undefined) {
    warn(`Couldn't list models at ${host}. Skipping pull.`);
    return;
  }

  miss(`model '${model}' not pulled`);
  const doPull = await confirm({
    message: `Pull model '${model}' now?`,
    default: true,
  });
  if (!doPull) {
    warn(`Skipped. Run \`ollama pull ${model}\` manually before smoke.`);
    return;
  }
  const code = await ollamaPullModel(model);
  if (code === 0) ok(`pulled '${model}'`);
  else warn(`ollama pull exited with ${code}`);
}

/**
 * Ollama serves plain HTTP on 11434. `https://` at the default port is
 * almost always a typo, and the connection silently hangs until a 30s
 * timeout — not what we want in a setup wizard. Reject it up front with
 * an actionable message. Allow explicit https only when the port is not
 * 11434 (someone has put TLS in front via a reverse proxy).
 */
function validateOllamaHost(v: string): true | string {
  if (!/^https?:\/\//.test(v)) {
    return "must start with http:// or https://";
  }
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return "not a valid URL";
  }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  if (parsed.protocol === "https:" && port === "11434") {
    return (
      "Ollama serves plain HTTP on 11434 — use http:// (or change the port " +
      "if you're proxying TLS in front)"
    );
  }
  return true;
}

function isLocalHost(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1" ||
      u.hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

async function stepSecrets(
  providers: ProviderChoice[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  const ollama = providers.find((p) => p.id === "ollama");
  if (ollama) {
    out.OLLAMA_HOST = ollama.settings.host ?? "http://localhost:11434";
  }

  if (providers.some((p) => p.id === "openrouter")) {
    section("OpenRouter");
    const key = await password({
      message: "OpenRouter API key (input hidden; leave blank to skip)",
      mask: "*",
    });
    if (key) out.OPENROUTER_API_KEY = key;
    else warn("Skipped — provider will fail at init until key is set in .env");
  }

  return out;
}

async function stepDefaultTask(
  providers: ProviderChoice[],
): Promise<{ provider: string; model: string }> {
  section("Default task routing");

  if (providers.length === 1) {
    const only = providers[0]!;
    const model =
      only.id === "ollama"
        ? (only.settings.defaultModel ?? "qwen3:14b")
        : await input({
            message: `Default model for ${only.id}`,
            default: "anthropic/claude-haiku-4.5",
          });
    return { provider: only.id, model };
  }

  const providerId = await select({
    message: "Which provider should handle the default task?",
    choices: providers.map((p) => ({ name: p.id, value: p.id })),
  });

  const model = await input({
    message: `Default model on ${providerId}`,
    default:
      providerId === "ollama"
        ? (providers.find((p) => p.id === "ollama")?.settings.defaultModel ??
          "qwen3:14b")
        : "anthropic/claude-haiku-4.5",
  });

  return { provider: providerId, model };
}

async function stepAdapters(repoRoot: string): Promise<void> {
  const byCategory = wizardsByCategory();
  const adapterWizards = byCategory.get("adapter") ?? [];
  if (adapterWizards.length === 0) {
    return; // Nothing registered yet (Sprint A); skip cleanly.
  }

  section("Source adapters");
  line(
    "  Cortex ingests from the sources you enable. More wizards land " +
      "as each adapter gets guided setup — the list will grow.",
  );

  const selected = await checkbox({
    message: "Which adapters do you want to enable now?",
    choices: adapterWizards.map((w) => ({
      name: `${w.name} — ${w.description}`,
      value: w.id,
    })),
    required: false,
  });

  for (const moduleId of selected) {
    const wizard = adapterWizards.find((w) => w.id === moduleId);
    if (!wizard) continue;
    try {
      const result = await runWizard(wizard);
      const written = await applyWizardResult({ repoRoot }, result);
      ok(`${wizard.name} configured`);
      for (const p of written.filesWritten) {
        line(`        ${path.relative(repoRoot, p)}`);
      }
    } catch (err) {
      warn(
        `${wizard.name} setup failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `You can re-run it later with \`przm-cortex add ${moduleId}\`.`,
      );
    }
  }

  if (selected.length === 0) {
    line(
      "  Skipped. You can enable adapters later with `przm-cortex add <module>` — " +
        `list options via \`przm-cortex modules\`.`,
    );
  }

  // Unused helper reference to satisfy the listWizards import when the
  // registry is empty. (kept so the import stays in case Sprint B adds
  // a step that needs it.)
  void listWizards;
}

/**
 * Pick setup mode (terminal prompts vs dashboard). Honors --web /
 * --cli flags, otherwise asks once and remembers inside this
 * invocation.
 */
async function pickSetupMode(args: readonly string[]): Promise<"cli" | "web"> {
  if (args.includes("--cli")) return "cli";
  if (args.includes("--web") || args.includes("--dashboard")) return "web";
  const mode = await select<"web" | "cli">({
    message: "How would you like to configure Cortex?",
    choices: [
      {
        value: "web",
        name: "Web dashboard (recommended)",
        description:
          "Bootstraps a workspace, then points you at `docker compose up` so the dashboard is a browser away.",
      },
      {
        value: "cli",
        name: "Terminal wizard",
        description:
          "Step-by-step prompts in this shell. Best for SSH / headless installs.",
      },
    ],
    default: "web",
  });
  return mode;
}

/**
 * The web setup path. Writes a minimal bootstrap workspace so the
 * dashboard has somewhere to land, then hands off to `docker compose
 * up` (or `przm-cortex up`). The browser finishes setup in the dashboard's
 * /setup page — wizards, secrets, and adapter wiring all live there.
 *
 * We don't spawn anything ourselves: long-running detached processes
 * on Windows were a pit of console-job / PowerShell pain, and Docker
 * is a cleaner way to keep Cortex alive across terminals.
 */
async function runWebSetup(repoRoot: string): Promise<number> {
  const writeRoot = await stepWorkspace(repoRoot);
  await ensureBootstrapConfig(writeRoot);

  const dashboardUrl = "http://localhost:3030";

  section("Start Cortex");
  line("  Run ONE of these in a separate terminal, then come back here:");
  line("");
  line("    docker compose up -d       # recommended — always-on, survives reboots");
  line("    przm-cortex start          # local dev — foreground, ctrl+C to stop");
  line("");
  line(`  The dashboard lives at ${dashboardUrl}/setup — finish configuration there.`);
  line("");

  const opened = await openBrowser(`${dashboardUrl}/setup`);
  if (opened) ok(`opened ${dashboardUrl}/setup in your browser`);
  else line(`  (couldn't auto-open — visit ${dashboardUrl}/setup after starting)`);
  line("");
  return 0;
}

/**
 * Make sure the workspace's config is usable for a dashboard-driven
 * setup — specifically, the HTTP sidecar must be enabled so the
 * browser can reach /api/*. Two cases:
 *
 *   1. No cortex.yaml yet — write a minimum-viable bootstrap.
 *   2. Seeded from a template with api.enabled: false — mutate the
 *      yaml in place to flip the flag. Preserves all other keys.
 *
 * We don't use cortex.local.yaml here because it's a full replacement,
 * not an overlay — an "api-only" local.yaml would hide llm/memory
 * entirely and fail schema validation.
 */
async function ensureBootstrapConfig(writeRoot: string): Promise<void> {
  const cfgPath = path.join(writeRoot, "config", "cortex.yaml");
  const envPath = path.join(writeRoot, ".env");

  if (!existsSync(cfgPath)) {
    const stub = [
      "# Bootstrap config written by `przm-cortex init --web`. The web",
      "# setup page fills in providers, secrets, and adapters.",
      "",
      "llm:",
      "  providers: {}",
      "  tasks:",
      "    # Placeholder — replaced by the web setup wizard once you pick",
      "    # a provider. OpenRouter is the recommended default; Ollama is",
      "    # an opt-in toggle for users with a local GPU box.",
      "    default: { provider: openrouter, model: \"anthropic/claude-haiku-4.5\" }",
      "",
      "api:",
      "  enabled: true",
      "  host: \"127.0.0.1\"",
      "  port: 4141",
      "",
      "adapters: {}",
      "",
    ].join("\n");
    await mkdir(path.dirname(cfgPath), { recursive: true });
    await writeFile(cfgPath, stub, "utf8");
  } else {
    // Mutate the existing cortex.yaml to guarantee api.enabled: true.
    // Parse → patch → restringify keeps the rest of the file intact.
    const raw = await readFile(cfgPath, "utf8");
    const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
    const api =
      (parsed.api && typeof parsed.api === "object"
        ? (parsed.api as Record<string, unknown>)
        : {}) as Record<string, unknown>;
    let changed = false;
    if (api.enabled !== true) {
      api.enabled = true;
      changed = true;
    }
    if (typeof api.host !== "string") {
      api.host = "127.0.0.1";
      changed = true;
    }
    if (typeof api.port !== "number") {
      api.port = 4141;
      changed = true;
    }
    if (changed) {
      parsed.api = api;
      await writeFile(cfgPath, stringifyYaml(parsed), "utf8");
    }
  }

  if (!existsSync(envPath)) {
    await writeFile(envPath, "# Secrets written by the setup wizard land here.\n", "utf8");
  }
}

// Lightweight formatters so we don't pull in chalk.
function header(s: string): void {
  process.stdout.write(`\n${s}\n${"=".repeat(s.length)}\n\n`);
}
function section(s: string): void {
  process.stdout.write(`\n${s}\n${"-".repeat(s.length)}\n`);
}
function line(s: string): void {
  process.stdout.write(`${s}\n`);
}
function ok(s: string): void {
  process.stdout.write(`  [ok]   ${s}\n`);
}
function miss(s: string): void {
  process.stdout.write(`  [miss] ${s}\n`);
}
function warn(s: string): void {
  process.stdout.write(`  [warn] ${s}\n`);
}
