import { writeFile, readFile, access, mkdir } from "node:fs/promises";
import path from "node:path";

export interface ProviderChoice {
  id: "ollama" | "openrouter";
  enabled: boolean;
  /** Provider-specific settings the wizard collected. */
  settings: Record<string, string>;
}

export interface WriteConfigInput {
  repoRoot: string;
  providers: ProviderChoice[];
  defaultTask: { provider: string; model: string };
  /** Secrets to merge into .env. Keys are env var names. */
  secrets: Record<string, string>;
}

export interface WriteResult {
  envPath: string;
  configPath: string;
  envWritten: boolean;
  configWritten: boolean;
  envBackupPath?: string;
  configBackupPath?: string;
}

/**
 * Writes .env and config/cortex.yaml. If either already exists, backs it up
 * first with a `.bak.<ts>` suffix and replaces. Never deletes anything.
 */
export async function writeConfig(
  input: WriteConfigInput,
): Promise<WriteResult> {
  const envPath = path.join(input.repoRoot, ".env");
  const configPath = path.join(input.repoRoot, "config", "cortex.yaml");

  await mkdir(path.dirname(configPath), { recursive: true });

  const envBackup = (await exists(envPath))
    ? await backup(envPath)
    : undefined;
  const configBackup = (await exists(configPath))
    ? await backup(configPath)
    : undefined;

  await writeFile(envPath, buildEnv(input), { encoding: "utf8" });
  await writeFile(configPath, buildCortexYaml(input), { encoding: "utf8" });

  return {
    envPath,
    configPath,
    envWritten: true,
    configWritten: true,
    ...(envBackup ? { envBackupPath: envBackup } : {}),
    ...(configBackup ? { configBackupPath: configBackup } : {}),
  };
}

function buildEnv(input: WriteConfigInput): string {
  const lines: string[] = [
    "# Written by `cortex init`. Regenerated on every run — back up customizations.",
    "",
    "# Upstream MCP services",
    `ENGRAM_MCP_URL=${input.secrets.ENGRAM_MCP_URL ?? "http://localhost:3101"}`,
    `PERSONA_MCP_URL=${input.secrets.PERSONA_MCP_URL ?? "http://localhost:3102"}`,
    "",
    "# LLM provider credentials",
  ];

  const forProvider = (id: ProviderChoice["id"]): ProviderChoice | undefined =>
    input.providers.find((p) => p.id === id);

  const ollama = forProvider("ollama");
  if (ollama?.enabled) {
    lines.push(`OLLAMA_HOST=${ollama.settings.host ?? "http://localhost:11434"}`);
  }

  const openrouter = forProvider("openrouter");
  if (openrouter?.enabled) {
    lines.push(`OPENROUTER_API_KEY=${input.secrets.OPENROUTER_API_KEY ?? ""}`);
  }

  lines.push(
    "",
    "# Runtime",
    "NODE_ENV=development",
    "LOG_LEVEL=info",
    "CORTEX_CONFIG_PATH=./config/cortex.yaml",
    "CORTEX_MCP_PORT=3100",
    "",
  );

  return lines.join("\n");
}

function buildCortexYaml(input: WriteConfigInput): string {
  const providers: Record<string, string[]> = {};
  for (const p of input.providers) {
    providers[p.id] = buildProviderBlock(p);
  }

  const providerBlocks = Object.entries(providers)
    .map(([id, block]) => `    ${id}:\n${block.map((l) => `      ${l}`).join("\n")}`)
    .join("\n");

  const tasks = [
    `    default:    { provider: ${input.defaultTask.provider}, model: "${input.defaultTask.model}" }`,
    `    structural: { provider: ${input.defaultTask.provider}, model: "${input.defaultTask.model}" }`,
    `    synthesis:  { provider: ${input.defaultTask.provider}, model: "${input.defaultTask.model}" }`,
    `    brief:      { provider: ${input.defaultTask.provider}, model: "${input.defaultTask.model}" }`,
    `    classify:   { provider: ${input.defaultTask.provider}, model: "${input.defaultTask.model}" }`,
  ].join("\n");

  const fallbackIds = input.providers
    .filter((p) => p.enabled && p.id !== input.defaultTask.provider)
    .map((p) => p.id);

  return [
    "# Written by `cortex init`. Re-run the wizard to regenerate.",
    "",
    "llm:",
    "  providers:",
    providerBlocks,
    "",
    "  tasks:",
    tasks,
    `    embed:      { provider: ${input.defaultTask.provider}, model: "nomic-embed-text" }`,
    "",
    `  fallbackChain: [${fallbackIds.join(", ")}]`,
    "",
    "memory:",
    "  primary: engram",
    "  # fallback: pgvector     # uncomment to enable the native Postgres fallback",
    "  # pgvector:",
    "  #   connectionString: \"${POSTGRES_URL}\"",
    "  #   embeddingDim: 768    # must match the embed model's dimension",
    "",
    "adapters: {}",
    "",
  ].join("\n");
}

function buildProviderBlock(p: ProviderChoice): string[] {
  const pkg =
    p.id === "ollama"
      ? "@cortex/provider-ollama"
      : "@cortex/provider-openrouter";

  const cfg: string[] = [];
  if (p.id === "ollama") {
    cfg.push(`host: "${"${OLLAMA_HOST}"}"`);
    if (p.settings.defaultModel) {
      cfg.push(`defaultModel: "${p.settings.defaultModel}"`);
    }
  } else if (p.id === "openrouter") {
    cfg.push('referer: "https://github.com/mattstvartak/cortex"');
    cfg.push('appTitle: "Cortex"');
  }

  const lines = [
    `package: "${pkg}"`,
    `enabled: ${p.enabled}`,
    "config:",
    ...cfg.map((c) => `  ${c}`),
  ];
  return lines;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function backup(p: string): Promise<string> {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const bak = `${p}.bak.${ts}`;
  const contents = await readFile(p);
  await writeFile(bak, contents);
  return bak;
}
