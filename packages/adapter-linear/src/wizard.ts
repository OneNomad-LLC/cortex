import { z } from "zod";
import type { WizardModule } from "@onenomad/cortex-core";
import { linearConfigSchema, type LinearConfig } from "./adapter.js";

/**
 * Declarative wizard spec for Linear. Collects team keys + per-team
 * Cortex project mapping via the shorthand `teamToProject` record.
 */
export const linearWizard: WizardModule<LinearConfig> = {
  id: "linear",
  name: "Linear",
  category: "adapter",
  description:
    "Ingest Linear issues and comments from one or more teams. Each " +
    "team can be mapped to a Cortex project slug so issues are tagged " +
    "on ingestion.",
  configSchema: linearConfigSchema,
  steps: [
    {
      key: "teams",
      prompt: "Team keys to sync (comma-separated, e.g. ENG, DESIGN). Leave blank for all teams visible to the key.",
      type: "list",
      itemPattern: /^[A-Za-z0-9_-]+$/,
    },
    {
      key: "teamToProject",
      prompt: "Cortex project slug for each team (press Enter to skip)",
      type: "repeat-per",
      source: "teams",
      sub: [
        {
          key: "__value",
          prompt: "Cortex project slug",
          type: "text",
          pattern: /^[a-z0-9-]*$/,
          patternHint: "lowercase letters, digits, and hyphens — or blank to skip",
        },
      ],
    },
    {
      key: "defaultProject",
      prompt: "Default project slug when no team mapping matches (optional)",
      type: "text",
      defaultValue: "",
    },
    {
      key: "pageSize",
      prompt: "Issues per API call (1-250, default 50)",
      type: "text",
      defaultValue: "50",
      pattern: /^\d+$/,
    },
    {
      key: "maxIssuesPerRun",
      prompt: "Max issues per sync run (0 = unlimited)",
      type: "text",
      defaultValue: "0",
      pattern: /^\d+$/,
    },
  ],
  secrets: [
    {
      envVar: "LINEAR_API_KEY",
      prompt: "Linear personal API key (create at linear.app/settings/api)",
      type: "password",
      required: true,
    },
  ],
  derivedTaxonomy: (state) => {
    const map = (state.teamToProject ?? {}) as Record<string, { __value?: string }>;
    const slugs = new Set<string>();
    for (const v of Object.values(map)) {
      if (v.__value) slugs.add(v.__value);
    }
    if (state.defaultProject && typeof state.defaultProject === "string") {
      slugs.add(state.defaultProject);
    }
    return {
      projects: [...slugs].filter(Boolean).map((slug) => ({ slug })),
    };
  },
};

// Coerce numeric strings + flatten repeat-per {__value} records into the
// flat `teamToProject` record that the adapter config expects.
const coercedConfigSchema = z.preprocess((val) => {
  if (typeof val !== "object" || val === null) return val;
  const obj = { ...(val as Record<string, unknown>) };
  for (const k of ["pageSize", "maxIssuesPerRun"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) obj[k] = Number(v);
    if (v === "" || v === undefined) delete obj[k];
  }
  // Flatten {team: {__value: "slug"}} → {team: "slug"}, drop blank entries.
  const raw = obj.teamToProject as Record<string, { __value?: string }> | undefined;
  if (raw && typeof raw === "object") {
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.__value === "string" && v.__value.length > 0) {
        flat[k] = v.__value;
      }
    }
    obj.teamToProject = flat;
  }
  return obj;
}, linearConfigSchema);

(linearWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
