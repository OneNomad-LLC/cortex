import { z } from "zod";
import type { WizardModule } from "@onenomad/cortex-core";
import { pgVectorConfigSchema, type PgVectorConfig } from "./backend.js";

/**
 * Wizard for the Postgres + pgvector memory backend. Installed as a
 * *fallback* to Engram — when Engram's MCP becomes unreachable, Cortex
 * flips to this backend for the rest of the session. Requires pgvector
 * installed on the target database (https://github.com/pgvector/pgvector).
 *
 * Accepts a full connection string *or* an env var reference (the YAML
 * loader expands `${POSTGRES_URL}` at boot). The wizard asks for the
 * env var name so the real secret never touches cortex.local.yaml.
 */
export const pgvectorWizard: WizardModule<PgVectorConfig> = {
  id: "pgvector",
  name: "pgvector",
  category: "memory",
  description:
    "Postgres + pgvector hybrid-search fallback for when Engram is " +
    "unreachable. Reciprocal-rank-fuses pgvector HNSW and tsvector GIN " +
    "so retrieval quality is close to Engram's LLM-driven pipeline.",
  configSchema: pgVectorConfigSchema,
  steps: [
    {
      key: "connectionString",
      prompt:
        "Env var reference for the Postgres DSN (e.g. ${POSTGRES_URL}) — the value lives in .env, not this file",
      type: "text",
      defaultValue: "${POSTGRES_URL}",
      pattern: /^\$\{[A-Z_][A-Z0-9_]*\}$/,
      patternHint: "must look like ${ALL_CAPS_NAME}",
    },
    {
      key: "table",
      prompt: "Table name for memories",
      type: "text",
      defaultValue: "cortex_memories",
      pattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
      patternHint: "letters, digits, underscores; must start with letter or underscore",
    },
    {
      key: "embeddingDim",
      prompt:
        "Embedding dimension (must match the model bound to llm.tasks.embed — nomic-embed-text = 768)",
      type: "text",
      defaultValue: "768",
      pattern: /^\d+$/,
    },
    {
      key: "defaultLimit",
      prompt: "Default search result cap",
      type: "text",
      defaultValue: "10",
      pattern: /^\d+$/,
    },
    {
      key: "rrfK",
      prompt:
        "Reciprocal-rank-fusion K constant (60 is the standard; lower = more diverse, higher = more agreement)",
      type: "text",
      defaultValue: "60",
      pattern: /^\d+$/,
    },
    {
      key: "channelMultiplier",
      prompt:
        "Candidates per channel as a multiple of defaultLimit (higher = better fusion, slower)",
      type: "text",
      defaultValue: "4",
      pattern: /^\d+$/,
    },
  ],
  secrets: [
    {
      envVar: "POSTGRES_URL",
      prompt: "Postgres DSN (postgres://user:pw@host:5432/db)",
      type: "password",
      required: true,
    },
  ],
};

const coercedConfigSchema = z.preprocess((val) => {
  if (typeof val !== "object" || val === null) return val;
  const obj = { ...(val as Record<string, unknown>) };
  for (const k of ["embeddingDim", "defaultLimit", "rrfK", "channelMultiplier"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) obj[k] = Number(v);
    if (v === "" || v === undefined) delete obj[k];
  }
  return obj;
}, pgVectorConfigSchema);

(pgvectorWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
