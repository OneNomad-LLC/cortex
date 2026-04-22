import { z } from "zod";
import type { WizardModule } from "@cortex/core";
import { gmailConfigSchema, type GmailConfig } from "./adapter.js";

/**
 * Gmail adapter config only — the OAuth refresh token is shared across
 * the Google adapters and set up separately via `cortex google-login`.
 * This wizard runs AFTER that login; the adapter fails at startup if the
 * token file is missing.
 */
export const gmailWizard: WizardModule<GmailConfig> = {
  id: "gmail",
  name: "Gmail",
  category: "adapter",
  description:
    "Ingest Gmail threads matching a search query. Run `cortex google-login` " +
    "first to authorize — this wizard only configures ingest scope.",
  configSchema: gmailConfigSchema,
  steps: [
    {
      key: "query",
      prompt: "Gmail search query (uses standard Gmail operators)",
      type: "text",
      defaultValue: "label:inbox newer_than:30d",
    },
    {
      key: "maxThreadsPerRun",
      prompt: "Max threads per sync run",
      type: "text",
      defaultValue: "50",
      pattern: /^\d+$/,
    },
    {
      key: "defaultProject",
      prompt: "Default project slug for ingested threads (optional)",
      type: "text",
      defaultValue: "",
    },
    // labelToProject is powerful but requires label ids which most users
    // don't know by heart. Leave it empty at wizard time and document
    // editing cortex.local.yaml directly if richer mapping is needed.
  ],
  secrets: [],
  derivedTaxonomy: (state) => {
    const slugs = new Set<string>();
    if (typeof state.defaultProject === "string" && state.defaultProject) {
      slugs.add(state.defaultProject);
    }
    return { projects: [...slugs].map((slug) => ({ slug })) };
  },
};

const coercedConfigSchema = z.preprocess((val) => {
  if (typeof val !== "object" || val === null) return val;
  const obj = { ...(val as Record<string, unknown>) };
  const v = obj.maxThreadsPerRun;
  if (typeof v === "string" && v.length > 0) obj.maxThreadsPerRun = Number(v);
  if (v === "" || v === undefined) delete obj.maxThreadsPerRun;
  return obj;
}, gmailConfigSchema);

(gmailWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
