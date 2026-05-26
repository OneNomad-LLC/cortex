import { z } from "zod";
import type { WizardModule } from "@onenomad/przm-cortex-core";
import { ollamaConfigSchema, type OllamaConfig } from "./provider.js";

export const ollamaWizard: WizardModule<OllamaConfig> = {
  id: "ollama",
  name: "Ollama",
  category: "provider",
  description:
    "Local Ollama instance for LLM inference and embeddings. No API " +
    "key required — just make sure `ollama serve` is running.",
  configSchema: ollamaConfigSchema,
  steps: [
    {
      key: "host",
      prompt: "Ollama HTTP endpoint",
      type: "text",
      defaultValue: "http://localhost:11434",
      pattern: /^https?:\/\/.+/,
      patternHint: "must be an http:// or https:// URL",
    },
    {
      key: "defaultModel",
      prompt: "Default model for non-embedding tasks (e.g. qwen3:14b, llama3.2:3b)",
      type: "text",
      defaultValue: "qwen3:14b",
      required: true,
    },
    {
      key: "keepAlive",
      prompt: "How long to keep a loaded model in memory (e.g. 30m, 1h)",
      type: "text",
      defaultValue: "30m",
    },
    {
      key: "timeoutMs",
      prompt: "Per-request timeout in milliseconds",
      type: "text",
      defaultValue: "120000",
      pattern: /^\d+$/,
    },
    {
      key: "think",
      prompt:
        "Enable reasoning/thinking mode for supported models? Most Cortex tasks don't need it.",
      type: "boolean",
      defaultValue: false,
    },
  ],
  secrets: [],
};

const coercedConfigSchema = z.preprocess((val) => {
  if (typeof val !== "object" || val === null) return val;
  const obj = { ...(val as Record<string, unknown>) };
  const t = obj.timeoutMs;
  if (typeof t === "string" && t.length > 0) obj.timeoutMs = Number(t);
  if (t === "" || t === undefined) delete obj.timeoutMs;
  return obj;
}, ollamaConfigSchema);

(ollamaWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
