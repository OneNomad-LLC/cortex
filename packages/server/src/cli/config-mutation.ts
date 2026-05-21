import { readFile, writeFile, rename, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { DerivedTaxonomy, WizardResult } from "@onenomad/przm-cortex-core";

/**
 * Atomic multi-file config mutation for Cortex.
 *
 * Every enable/configure/disable operation on a module boils down to
 * edits in three files:
 *
 *   config/cortex.local.yaml      — adapters/providers/memory/etc.
 *   .env                          — secrets
 *   config/projects.local.yaml    — taxonomy (may expand to people/engagements)
 *
 * Each file gets the tmp-then-rename atomic write pattern so a crash
 * mid-write never leaves a corrupted half-file behind. The service is
 * shared by the CLI runner and (later) the dashboard's server actions,
 * so config mutations take the same path regardless of entry point.
 */

export interface ConfigMutationOptions {
  /** Repo root. Used to resolve relative paths for config files + .env. */
  repoRoot: string;
}

/**
 * Enable a module (adapter, provider, etc.) with the collected wizard
 * result. Creates cortex.local.yaml from the template if it doesn't
 * already exist so the operator never starts from a blank file.
 */
export async function applyWizardResult(
  opts: ConfigMutationOptions,
  result: WizardResult,
): Promise<{ filesWritten: string[] }> {
  const touched: string[] = [];
  const category = result.category ?? "adapter";

  // 1. cortex.local.yaml — the YAML section varies by category.
  const configPath = await ensureLocalCopy(
    path.join(opts.repoRoot, "config", "cortex.yaml"),
  );
  await mutateYaml(configPath, (doc) => {
    const cfg = (doc ?? {}) as Record<string, unknown>;
    return applyByCategory(cfg, result, category);
  });
  touched.push(configPath);

  // 2. .env — merge secrets.
  if (Object.keys(result.secrets).length > 0) {
    const envPath = path.join(opts.repoRoot, ".env");
    await mergeEnv(envPath, result.secrets);
    touched.push(envPath);
  }

  // 3. Derived taxonomy.
  if (result.derivedTaxonomy) {
    if (result.derivedTaxonomy.projects?.length) {
      const projectsPath = await ensureLocalCopy(
        path.join(opts.repoRoot, "config", "projects.yaml"),
      );
      await mergeProjects(projectsPath, result.derivedTaxonomy.projects);
      touched.push(projectsPath);
    }
    // Room for people + engagements as those wizards arrive.
  }

  return { filesWritten: touched };
}

/**
 * Set the default LLM task to a specific provider+model. Writes to
 * `cortex.local.yaml` so the change survives base-template rewrites.
 *
 * Used by the env-driven bootstrap path (`seedLlmProviderFromEnv`)
 * for per-tenant Cortex Cloud deployments where pyre-web injects
 * the provider config via env at machine create time. Without this,
 * a fresh tenant comes up with the bootstrap default model
 * ("anthropic/claude-haiku-4.5") even when the configured provider
 * is Azure OpenAI behind the openrouter shim — which would 404 on
 * any LLM call. Idempotent.
 */
export async function setDefaultLlmTask(opts: {
  repoRoot: string
  provider: string
  model: string
  /**
   * Apply the same provider+model to these named tasks too. Defaults
   * to ['default'] only; pass extra task purposes (extract, classify,
   * summarize, brief, structural, synthesis) when you want them to
   * route to the same model.
   */
  tasks?: readonly string[]
}): Promise<{ filesWritten: string[] }> {
  const configPath = await ensureLocalCopy(
    path.join(opts.repoRoot, "config", "cortex.yaml"),
  )
  const tasks = opts.tasks ?? ["default"]
  await mutateYaml(configPath, (doc) => {
    const cfg = (doc ?? {}) as Record<string, unknown>
    const llm = ((cfg.llm as Record<string, unknown>) ?? {}) as Record<string, unknown>
    const taskMap = ((llm.tasks as Record<string, unknown>) ?? {}) as Record<string, unknown>
    for (const taskName of tasks) {
      taskMap[taskName] = { provider: opts.provider, model: opts.model }
    }
    llm.tasks = taskMap
    cfg.llm = llm
    return cfg
  })
  return { filesWritten: [configPath] }
}

/**
 * Set memory.pgvector.useLocalEmbedder. Used by the env-driven
 * bootstrap to pin embeddings to the local Xenova model when the
 * configured LLM provider can't do embeddings (Azure chat-only,
 * Anthropic, etc.). See clients/memory.ts for how this is honored.
 */
export async function setUseLocalEmbedder(opts: {
  repoRoot: string
  value: boolean
}): Promise<{ filesWritten: string[] }> {
  const configPath = await ensureLocalCopy(
    path.join(opts.repoRoot, "config", "cortex.yaml"),
  )
  await mutateYaml(configPath, (doc) => {
    const cfg = (doc ?? {}) as Record<string, unknown>
    const memory = ((cfg.memory as Record<string, unknown>) ?? {}) as Record<string, unknown>
    const pgvector = ((memory.pgvector as Record<string, unknown>) ?? {}) as Record<string, unknown>
    pgvector.useLocalEmbedder = opts.value
    memory.pgvector = pgvector
    cfg.memory = memory
    return cfg
  })
  return { filesWritten: [configPath] }
}

/**
 * Flip a module off. Leaves its config in place so re-enabling doesn't
 * lose settings. Only touches cortex.local.yaml.
 */
export async function disableModule(
  opts: ConfigMutationOptions,
  moduleId: string,
  category: "adapter" | "provider" | "memory" | "toolkit" | "webhook" = "adapter",
): Promise<void> {
  const configPath = await ensureLocalCopy(
    path.join(opts.repoRoot, "config", "cortex.yaml"),
  );
  await mutateYaml(configPath, (doc) => {
    const cfg = (doc ?? {}) as Record<string, unknown>;
    switch (category) {
      case "adapter": {
        const adapters = ((cfg.adapters as Record<string, unknown>) ?? {}) as Record<string, unknown>;
        const current = (adapters[moduleId] as Record<string, unknown>) ?? {};
        adapters[moduleId] = { ...current, enabled: false };
        cfg.adapters = adapters;
        return cfg;
      }
      case "provider": {
        const llm = ((cfg.llm as Record<string, unknown>) ?? {}) as Record<string, unknown>;
        const providers = ((llm.providers as Record<string, unknown>) ?? {}) as Record<string, unknown>;
        const current = (providers[moduleId] as Record<string, unknown>) ?? {};
        providers[moduleId] = { ...current, enabled: false };
        llm.providers = providers;
        cfg.llm = llm;
        return cfg;
      }
      case "memory": {
        // "Disable" for a memory backend = stop using it as the fallback.
        // Leave the config block in place so re-enabling keeps settings.
        const memory = ((cfg.memory as Record<string, unknown>) ?? {}) as Record<string, unknown>;
        if (memory.fallback === moduleId) delete memory.fallback;
        cfg.memory = memory;
        return cfg;
      }
      case "webhook": {
        const webhooks = ((cfg.webhooks as Record<string, unknown>) ?? {}) as Record<string, unknown>;
        webhooks.enabled = false;
        cfg.webhooks = webhooks;
        return cfg;
      }
      case "toolkit": {
        const toolkits = ((cfg.toolkits as Record<string, unknown>) ?? {}) as Record<string, unknown>;
        const current = (toolkits[moduleId] as Record<string, unknown>) ?? {};
        toolkits[moduleId] = { ...current, enabled: false };
        cfg.toolkits = toolkits;
        return cfg;
      }
      default: {
        const _exhaust: never = category;
        void _exhaust;
        return cfg;
      }
    }
  });
}

/**
 * Read a module's current config from cortex.local.yaml (or the template
 * if the local doesn't exist). Used by `cortex configure` to pre-fill
 * wizard defaults with the current values.
 */
export async function readModuleConfig(
  opts: ConfigMutationOptions,
  moduleId: string,
  category: "adapter" | "provider" | "memory" | "toolkit" | "webhook" = "adapter",
): Promise<Record<string, unknown> | undefined> {
  const localPath = path.join(opts.repoRoot, "config", "cortex.local.yaml");
  const basePath = path.join(opts.repoRoot, "config", "cortex.yaml");
  const source = await tryReadYaml(localPath) ?? await tryReadYaml(basePath);
  if (!source) return undefined;

  switch (category) {
    case "adapter": {
      const adapters = source.adapters as Record<string, unknown> | undefined;
      const entry = adapters?.[moduleId] as { config?: Record<string, unknown> } | undefined;
      return entry?.config;
    }
    case "provider": {
      const llm = source.llm as Record<string, unknown> | undefined;
      const providers = llm?.providers as Record<string, unknown> | undefined;
      const entry = providers?.[moduleId] as { config?: Record<string, unknown> } | undefined;
      return entry?.config;
    }
    case "memory": {
      const memory = source.memory as Record<string, unknown> | undefined;
      return memory?.[moduleId] as Record<string, unknown> | undefined;
    }
    case "webhook": {
      return source.webhooks as Record<string, unknown> | undefined;
    }
    case "toolkit": {
      const toolkits = source.toolkits as Record<string, unknown> | undefined;
      return toolkits?.[moduleId] as Record<string, unknown> | undefined;
    }
  }
}

// --- internals ---

/**
 * Sensible default cron for each adapter when none is specified.
 * Picked per-source based on how frequently content realistically
 * changes + API rate limits. Users override via /adapters/[id].
 */
const DEFAULT_SCHEDULES: Record<string, string> = {
  // Source-control: repos change constantly, pull hourly to keep
  // embeddings warm without hammering the API.
  github: "0 * * * *",
  bitbucket: "0 * * * *",
  // Wiki-style: updated throughout the day but not minute-by-minute.
  confluence: "0 */4 * * *",
  notion: "0 */4 * * *",
  // Conversation logs: real-time-ish, but pulling every 15 min is
  // plenty for retrieval freshness.
  slack: "*/15 * * * *",
  gmail: "*/15 * * * *",
  // Meetings / events: once an hour keeps the pre-meeting brief
  // pipeline fresh without being spammy.
  "google-calendar": "0 * * * *",
  loom: "0 * * * *",
  // PM tools: tickets move on a slower cadence.
  linear: "0 */2 * * *",
  jira: "0 */2 * * *",
  // Drive: pull nightly — most adapters only care about recent docs.
  "google-drive": "0 2 * * *",
  // File-watcher based: stream() handles live updates; cron is just a
  // periodic re-scan to catch anything the watcher missed.
  obsidian: "0 */6 * * *",
};

function buildAdapterEntry(result: WizardResult): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    package: `@onenomad/przm-cortex-adapter-${result.moduleId}`,
    enabled: true,
    config: result.config as Record<string, unknown>,
  };
  const defaultSchedule = DEFAULT_SCHEDULES[result.moduleId];
  if (defaultSchedule) entry.schedule = defaultSchedule;
  return entry;
}

function buildProviderEntry(result: WizardResult): Record<string, unknown> {
  return {
    package: `@onenomad/przm-cortex-provider-${result.moduleId}`,
    enabled: true,
    config: result.config as Record<string, unknown>,
  };
}

/**
 * Apply a wizard result to the in-memory YAML doc according to its
 * category. Four shapes are supported:
 *
 *   adapter   → `adapters.<id>         = { package, enabled, config }`
 *   provider  → `llm.providers.<id>    = { package, enabled, config }`
 *   memory    → `memory.<id>           = config` (plus `memory.fallback` hint)
 *   webhook   → `webhooks              = { ...webhooks, ...config }`
 */
function applyByCategory(
  cfg: Record<string, unknown>,
  result: WizardResult,
  category: "adapter" | "provider" | "memory" | "toolkit" | "webhook",
): Record<string, unknown> {
  switch (category) {
    case "adapter": {
      const adapters = ((cfg.adapters as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      // Merge rather than clobber — a re-run of the wizard should only
      // overwrite what the wizard defines, preserving unrelated fields
      // like `schedule` that the user set separately.
      const existing = (adapters[result.moduleId] as Record<string, unknown>) ?? {};
      adapters[result.moduleId] = { ...existing, ...buildAdapterEntry(result) };
      cfg.adapters = adapters;
      return cfg;
    }
    case "provider": {
      const llm = ((cfg.llm as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      const providers = ((llm.providers as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      const existing = (providers[result.moduleId] as Record<string, unknown>) ?? {};
      providers[result.moduleId] = { ...existing, ...buildProviderEntry(result) };
      llm.providers = providers;
      cfg.llm = llm;
      return cfg;
    }
    case "memory": {
      const memory = ((cfg.memory as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      // Memory wizards land their config under `memory.<id>` (e.g.
      // `memory.pgvector = { connectionString, table, ... }`) and hint
      // the runtime by setting memory.fallback = <id>. The primary stays
      // whatever the template had (usually "engram").
      memory[result.moduleId] = result.config as Record<string, unknown>;
      if (result.moduleId !== "engram" && !memory.fallback) {
        memory.fallback = result.moduleId;
      }
      cfg.memory = memory;
      return cfg;
    }
    case "webhook": {
      const existing = ((cfg.webhooks as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      cfg.webhooks = { ...existing, ...(result.config as Record<string, unknown>) };
      return cfg;
    }
    case "toolkit": {
      const toolkits = ((cfg.toolkits as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      toolkits[result.moduleId] = result.config as Record<string, unknown>;
      cfg.toolkits = toolkits;
      return cfg;
    }
    default: {
      const _exhaust: never = category;
      void _exhaust;
      return cfg;
    }
  }
}

/**
 * If `<dir>/<name>.local.yaml` doesn't exist, copy the committed
 * `<dir>/<name>.yaml` template to it so the first write has somewhere
 * to land. Returns the local path either way.
 */
export async function ensureLocalCopy(templatePath: string): Promise<string> {
  const ext = path.extname(templatePath);
  const base = templatePath.slice(0, -ext.length);
  const localPath = `${base}.local${ext}`;
  try {
    await readFile(localPath, "utf8");
    return localPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Create from template. If the template is also missing, write an
  // empty YAML doc.
  try {
    await copyFile(templatePath, localPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(path.dirname(localPath), { recursive: true });
    await atomicWrite(localPath, "");
  }
  return localPath;
}

/**
 * Read a YAML file, pass the parsed doc through `mutator`, write back
 * atomically. Preserves YAML structure loosely — we round-trip via
 * `yaml` package's default stringify, which keeps basic shape but does
 * not preserve comments. For the local file that's acceptable — the
 * committed template carries the comments, the local is just data.
 */
async function mutateYaml(
  filePath: string,
  mutator: (doc: unknown) => unknown,
): Promise<void> {
  const raw = await readFile(filePath, "utf8").catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  });
  const doc = raw.trim().length > 0 ? parseYaml(raw) : {};
  const next = mutator(doc) ?? {};
  const out = stringifyYaml(next, { indent: 2, lineWidth: 0 });
  await atomicWrite(filePath, out);
}

async function tryReadYaml(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseYaml(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Append/update key=value entries in .env. Preserves existing lines and
 * their order; unknown keys are appended with a section header the first
 * time a group is added (for readability).
 *
 * Exported so the dashboard token CLI can share the same atomic write
 * path — every place that touches `.env` should go through here.
 */
export async function mergeEnv(
  filePath: string,
  entries: Record<string, string>,
): Promise<void> {
  let existing = await readFile(filePath, "utf8").catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  });
  if (existing && !existing.endsWith("\n")) existing += "\n";

  const lines = existing.split("\n");
  const keyToLineIndex = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^([A-Z0-9_]+)\s*=/);
    if (m) keyToLineIndex.set(m[1]!, i);
  }

  const appended: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const newLine = `${key}=${quoteIfNeeded(value)}`;
    const existingIdx = keyToLineIndex.get(key);
    if (existingIdx !== undefined) {
      lines[existingIdx] = newLine;
    } else {
      appended.push(newLine);
    }
  }

  const combined =
    [...lines, ...(appended.length > 0 ? ["", ...appended] : [])]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  await atomicWrite(filePath, combined.endsWith("\n") ? combined : `${combined}\n`);
}

/**
 * Remove keys from a .env file. No-op if a key isn't present. Returns
 * the set of keys actually removed so callers can report `revoked: 0`
 * vs `revoked: N` without re-reading the file.
 */
export async function removeEnvKeys(
  filePath: string,
  keys: ReadonlyArray<string>,
): Promise<string[]> {
  let existing = await readFile(filePath, "utf8").catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  });
  if (existing.length === 0) return [];
  if (existing && !existing.endsWith("\n")) existing += "\n";
  const lines = existing.split("\n");
  const keySet = new Set(keys);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)\s*=/);
    if (m && keySet.has(m[1]!)) {
      removed.push(m[1]!);
      continue;
    }
    kept.push(line);
  }
  if (removed.length === 0) return [];
  const combined = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  await atomicWrite(filePath, combined.endsWith("\n") ? combined : `${combined}\n`);
  return removed;
}

function quoteIfNeeded(value: string): string {
  // Only quote when necessary — contains whitespace or #.
  if (/[\s#]/.test(value)) {
    const escaped = value.replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Add missing project slugs to projects.local.yaml. Existing slugs are
 * left alone — the wizard doesn't overwrite user-curated entries.
 */
export async function mergeProjects(
  filePath: string,
  projects: DerivedTaxonomy["projects"] & {},
): Promise<void> {
  await mutateYaml(filePath, (doc) => {
    const cfg = (doc ?? {}) as { projects?: unknown[] };
    const existing = Array.isArray(cfg.projects) ? cfg.projects : [];
    const bySlug = new Map<string, Record<string, unknown>>();
    for (const entry of existing) {
      if (entry && typeof entry === "object" && "slug" in entry) {
        bySlug.set((entry as { slug: string }).slug, entry as Record<string, unknown>);
      }
    }
    for (const proj of projects) {
      const current = bySlug.get(proj.slug);
      if (current) {
        // Merge source hints into an existing entry — never overwrite
        // user-curated fields. Lets discovery re-runs enrich a project
        // that was partially set up by hand.
        if (proj.sources && Object.keys(proj.sources).length > 0) {
          const existingSources =
            current.sources && typeof current.sources === "object"
              ? (current.sources as Record<string, unknown>)
              : {};
          current.sources = { ...proj.sources, ...existingSources };
        }
        continue;
      }
      bySlug.set(proj.slug, {
        slug: proj.slug,
        name: proj.name ?? proj.slug,
        ...(proj.description ? { description: proj.description } : {}),
        active: true,
        ...(proj.sources && Object.keys(proj.sources).length > 0
          ? { sources: proj.sources }
          : {}),
      });
    }
    return { ...cfg, projects: [...bySlug.values()] };
  });
}

/**
 * Add a path to `privateModules` in cortex.local.yaml. Deduplicates
 * against existing entries. The path written is whatever the caller
 * passes — typically the CONTAINER-side path (`/root/.cortex/modules/
 * <name>`) because cortex reads this file from inside Docker.
 */
export async function addPrivateModule(
  opts: ConfigMutationOptions,
  modulePath: string,
): Promise<{ filePath: string; added: boolean }> {
  const configPath = await ensureLocalCopy(
    path.join(opts.repoRoot, "config", "cortex.yaml"),
  );
  let added = false;
  await mutateYaml(configPath, (doc) => {
    const cfg = (doc ?? {}) as { privateModules?: unknown };
    const current = Array.isArray(cfg.privateModules)
      ? (cfg.privateModules as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    if (current.includes(modulePath)) {
      return cfg;
    }
    added = true;
    return { ...cfg, privateModules: [...current, modulePath] };
  });
  return { filePath: configPath, added };
}

/**
 * Remove a path from `privateModules`. Returns `removed: false` when
 * the path wasn't registered — that's not an error, just a no-op.
 */
export async function removePrivateModule(
  opts: ConfigMutationOptions,
  modulePath: string,
): Promise<{ filePath: string; removed: boolean }> {
  const configPath = await ensureLocalCopy(
    path.join(opts.repoRoot, "config", "cortex.yaml"),
  );
  let removed = false;
  await mutateYaml(configPath, (doc) => {
    const cfg = (doc ?? {}) as { privateModules?: unknown };
    const current = Array.isArray(cfg.privateModules)
      ? (cfg.privateModules as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    const next = current.filter((p) => p !== modulePath);
    if (next.length === current.length) return cfg;
    removed = true;
    return { ...cfg, privateModules: next };
  });
  return { filePath: configPath, removed };
}

/**
 * Read the current `privateModules` list from cortex.local.yaml,
 * falling back to the committed template. Returns `[]` when the key
 * is missing or malformed.
 */
export async function listPrivateModulesFromConfig(
  opts: ConfigMutationOptions,
): Promise<string[]> {
  const localPath = path.join(opts.repoRoot, "config", "cortex.local.yaml");
  const templatePath = path.join(opts.repoRoot, "config", "cortex.yaml");
  const doc =
    (await tryReadYaml(localPath)) ?? (await tryReadYaml(templatePath)) ?? {};
  const raw = (doc as { privateModules?: unknown }).privateModules;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, filePath);
}

/**
 * Persist the live custom-memory-type set back to cortex.yaml's
 * `taxonomy.customTypes` stanza. The MemoryTypeRegistry's `persist`
 * callback points here, so an auto-add at ingest time survives a
 * restart and an operator's UI edit lands in the same place.
 *
 * Takes the explicit config path (not just repoRoot) because we want
 * to write into the workspace's cortex.yaml, not the committed
 * template. The boot path wires its own resolved path.
 */
export async function persistCustomTypes(
  configPath: string,
  types: Array<{
    slug: string;
    label?: string | undefined;
    description?: string | undefined;
    source: "config" | "auto";
  }>,
): Promise<void> {
  await mutateYaml(configPath, (doc) => {
    const obj = (doc ?? {}) as Record<string, unknown>;
    const taxonomy = ((obj.taxonomy as Record<string, unknown>) ?? {}) as Record<
      string,
      unknown
    >;
    taxonomy.customTypes = types.map((t) => ({
      slug: t.slug,
      ...(t.label !== undefined ? { label: t.label } : {}),
      ...(t.description !== undefined ? { description: t.description } : {}),
      source: t.source,
    }));
    obj.taxonomy = taxonomy;
    return obj;
  });
}
