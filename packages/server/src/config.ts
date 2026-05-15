import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const taskBindingSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const providerEntrySchema = z.object({
  package: z.string().min(1),
  enabled: z.boolean().default(false),
  config: z.record(z.unknown()).default({}),
});

export const adapterEntrySchema = z.object({
  package: z.string().min(1),
  enabled: z.boolean().default(false),
  schedule: z.string().optional(),
  config: z.record(z.unknown()).default({}),
});

export const memoryBackendName = z.enum(["engram", "pgvector"]);

export const memoryConfigSchema = z
  .object({
    /** Primary backend. Falls back to `fallback` at startup if unhealthy. */
    primary: memoryBackendName.default("engram"),
    /** Optional fallback backend. Omit or set equal to primary for none. */
    fallback: memoryBackendName.optional(),
    engram: z
      .object({
        command: z.string().optional(),
        args: z.array(z.string()).default([]),
        env: z.record(z.string()).default({}),
      })
      .default({}),
    pgvector: z
      .object({
        /**
         * 'external' (default) connects to a real Postgres server via
         * connectionString. 'embedded' spawns PGlite in-process — no
         * Docker, no system PG, no port. The Pyre 'Install Cortex'
         * flow defaults to embedded so the user gets a working KB
         * with zero external setup.
         */
        mode: z.enum(["external", "embedded"]).default("external"),
        connectionString: z.string().optional(),
        /**
         * Filesystem path for the embedded PGlite database. Required
         * when mode='embedded'; ignored otherwise. Path can be relative
         * (resolved against cwd at boot) or absolute.
         */
        dataDir: z.string().optional(),
        table: z.string().default("cortex_memories"),
        embeddingDim: z.number().int().positive().default(768),
        /** Task id to use when calling router.embed(). Default: 'embed'. */
        embedTask: z.string().default("embed"),
        /**
         * Force the bundled local Xenova embedder even when an LLM router
         * is configured. Set true when your chosen LLM provider doesn't
         * have an embedding model — most common case: Azure OpenAI behind
         * the openrouter shim, where the configured chat model
         * (gpt-4o-mini) is not an embedding model and Azure embedding
         * deployments are a separate resource. Without this, every
         * kb_search query 500s with `Provider does not support embeddings`.
         * Default false to preserve behavior for operators with
         * embedding-capable providers (real OpenRouter, Ollama with an
         * embedding model loaded, etc.).
         */
        useLocalEmbedder: z.boolean().default(false),
      })
      .default({}),
  })
  .default({});

export const webhooksConfigSchema = z
  .object({
    /** Off by default — webhooks only start when an operator explicitly opts in. */
    enabled: z.boolean().default(false),
    /** Bind host. 0.0.0.0 so a reverse proxy / Tailscale Funnel can forward. */
    host: z.string().default("0.0.0.0"),
    port: z.number().int().nonnegative().default(4040),
  })
  .default({});

export const apiConfigSchema = z
  .object({
    /**
     * Off by default — the dashboard API only boots when the operator opts
     * in. Like webhooks, it's a new surface and should stay dormant until
     * an operator explicitly wants it. Install scripts targeting remote
     * deploys (curl|sh, docker-compose) flip this to true.
     */
    enabled: z.boolean().default(false),
    /**
     * Bind host. Localhost by default because the dashboard is a per-user
     * local app; exposing the API over a LAN/Tailscale is an opt-in move.
     * Remote installs override to 0.0.0.0.
     */
    host: z.string().default("127.0.0.1"),
    port: z.number().int().nonnegative().default(4141),
  })
  .default({});

export const mcpConfigSchema = z
  .object({
    /**
     * Transport for the MCP server. 'stdio' = subprocess (Pyre / Claude
     * Desktop launch Cortex per-session). 'http' = long-running HTTP
     * server (remote VPS deploys, hosted Cortex, anything where a
     * client connects over the network). Env var CORTEX_MCP_TRANSPORT
     * still works as an override at boot.
     */
    transport: z.enum(["stdio", "http"]).default("stdio"),
    /**
     * Host to bind when transport='http'. 127.0.0.1 by default for
     * local installs; remote deploys override to 0.0.0.0 (firewall
     * or reverse proxy in front).
     */
    host: z.string().default("127.0.0.1"),
    port: z.number().int().nonnegative().default(3100),
  })
  .default({});

/**
 * Customer-extensible memory taxonomy. Built-in canonical types are
 * defined in `@onenomad/cortex-core > BUILT_IN_MEMORY_TYPES`; this
 * stanza adds per-workspace types on top. `source: "auto"` entries
 * are the ones the ingest path registered from unknown classifier
 * output — operators promote them to `"config"` (or delete them) from
 * the dashboard's Memory Types tab.
 */
export const customMemoryTypeSchema = z.object({
  slug: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  source: z.enum(["config", "auto"]).default("config"),
});

export const taxonomyConfigSchema = z
  .object({
    customTypes: z.array(customMemoryTypeSchema).default([]),
  })
  .default({});

export const cortexConfigSchema = z.object({
  llm: z.object({
    providers: z.record(providerEntrySchema),
    tasks: z
      .record(taskBindingSchema)
      .refine((t) => "default" in t, {
        message: "llm.tasks must include a 'default' entry",
      }),
    fallbackChain: z.array(z.string()).default([]),
  }),
  memory: memoryConfigSchema,
  webhooks: webhooksConfigSchema,
  api: apiConfigSchema,
  mcp: mcpConfigSchema,
  adapters: z.record(adapterEntrySchema).default({}),
  taxonomy: taxonomyConfigSchema,
  /**
   * Absolute paths to private/personal Cortex module directories
   * loaded at startup. Each must contain a `dist/index.js` exporting
   * `mcpTools`. See `server/src/private-modules.ts` + the companion
   * `cortex-private/` repo for the contract. Empty by default.
   */
  privateModules: z.array(z.string().min(1)).default([]),
});

export type WebhooksConfig = z.infer<typeof webhooksConfigSchema>;
export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type TaxonomyConfig = z.infer<typeof taxonomyConfigSchema>;
export type CustomMemoryTypeConfig = z.infer<typeof customMemoryTypeSchema>;

export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
export type MemoryBackendName = z.infer<typeof memoryBackendName>;

export type CortexConfig = z.infer<typeof cortexConfigSchema>;
export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type AdapterEntry = z.infer<typeof adapterEntrySchema>;

/**
 * Loads and validates cortex.yaml.
 *
 * Resolution order (first hit wins):
 *   1. `<dir>/<name>.local.yaml`   — caller's real, gitignored config
 *   2. `<dir>/<name>.yaml`         — committed template
 *
 * Rationale: real deployment data (workspace names, space keys, client
 * mappings) must never be committed. Operators write their real config into
 * `cortex.local.yaml`, which is in .gitignore, and the loader transparently
 * prefers it. See docs/PRIVACY.md.
 *
 * Expands `${ENV_VAR}` references from `process.env` in string values.
 */
export async function loadCortexConfig(configPath: string): Promise<CortexConfig> {
  const resolved = await resolveLocalFirst(configPath);
  const raw = await readFile(resolved, "utf8");
  const substituted = expandEnv(raw);
  const parsedRaw: unknown = parseYaml(substituted);
  // Empty / comments-only YAML documents parse to null. Substituting
  // {} lets Zod emit the actual field-by-field "missing llm, missing
  // api" errors instead of a root-level "Expected object, received
  // null" that tells the user nothing about what's missing.
  const parsed = parsedRaw ?? {};
  const result = cortexConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      [
        `Invalid cortex config at ${resolved}:`,
        issues,
        "",
        "Hint: if this is a new workspace, open the dashboard's Setup page",
        "(http://localhost:3030/setup) to configure providers + adapters, or run",
        "`cortex init` for the terminal wizard.",
      ].join("\n"),
    );
  }
  return applyEnvOverrides(result.data);
}

/**
 * Select fields (today: api.host / api.port / api.enabled) can be overridden
 * via env vars so a Docker image or VPS deploy doesn't need to hand-edit a
 * user's workspace config. The overrides kick in only when the env var is
 * present — absent vars leave the YAML value untouched.
 */
export function applyEnvOverrides(cfg: CortexConfig): CortexConfig {
  const envHost = process.env.CORTEX_API_HOST;
  const envPort = process.env.CORTEX_API_PORT;
  const envEnabled = process.env.CORTEX_API_ENABLED;
  if (!envHost && !envPort && !envEnabled) return cfg;
  return {
    ...cfg,
    api: {
      ...cfg.api,
      ...(envHost ? { host: envHost } : {}),
      ...(envPort ? { port: parseIntOrThrow("CORTEX_API_PORT", envPort) } : {}),
      ...(envEnabled ? { enabled: envEnabled === "true" || envEnabled === "1" } : {}),
    },
  };
}

function parseIntOrThrow(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer; got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Given a path like `config/cortex.yaml`, prefer `config/cortex.local.yaml`
 * if it exists. Same-directory, same-basename, `.local.yaml` suffix. Used by
 * every config loader (cortex.yaml, projects.yaml, people.yaml, future
 * engagements.yaml) so the pattern is uniform.
 */
export async function resolveLocalFirst(configPath: string): Promise<string> {
  const ext = path.extname(configPath);
  if (ext !== ".yaml" && ext !== ".yml") return configPath;
  const base = configPath.slice(0, -ext.length);
  const localPath = `${base}.local${ext}`;
  try {
    await readFile(localPath, "utf8");
    return localPath;
  } catch {
    return configPath;
  }
}

/**
 * `${FOO}` in YAML string positions is replaced with process.env.FOO. Throws
 * a readable error listing every missing/empty variable so the user knows
 * which .env entry to fill in, rather than surfacing as an opaque Zod
 * validation error downstream.
 *
 * Lines starting with `#` are treated as YAML comments and left untouched,
 * so commented-out config blocks don't require their env vars to be set.
 */
export function expandEnv(text: string): string {
  const missing = new Set<string>();
  const lines = text.split(/\r?\n/);
  const out = lines
    .map((line) => {
      if (/^\s*#/.test(line)) return line;
      return line.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
        const val = process.env[name];
        if (val === undefined || val === "") {
          missing.add(name);
          return "";
        }
        return val;
      });
    })
    .join("\n");
  if (missing.size > 0) {
    throw new Error(
      `config references unset environment variables: ${[...missing].join(", ")}. ` +
        `Set them in .env or run \`cortex init\` to regenerate.`,
    );
  }
  return out;
}
