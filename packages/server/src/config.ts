import { readFile } from "node:fs/promises";
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
        connectionString: z.string().optional(),
        table: z.string().default("cortex_memories"),
        embeddingDim: z.number().int().positive().default(768),
        /** Task id to use when calling router.embed(). Default: 'embed'. */
        embedTask: z.string().default("embed"),
      })
      .default({}),
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
  adapters: z.record(adapterEntrySchema).default({}),
});

export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
export type MemoryBackendName = z.infer<typeof memoryBackendName>;

export type CortexConfig = z.infer<typeof cortexConfigSchema>;
export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type AdapterEntry = z.infer<typeof adapterEntrySchema>;

/**
 * Loads and validates cortex.yaml. Expands `${ENV_VAR}` references from
 * `process.env` in string values only.
 */
export async function loadCortexConfig(path: string): Promise<CortexConfig> {
  const raw = await readFile(path, "utf8");
  const substituted = expandEnv(raw);
  const parsed: unknown = parseYaml(substituted);
  return cortexConfigSchema.parse(parsed);
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
