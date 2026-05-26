import { z } from "zod";
import type { WizardModule } from "@onenomad/przm-cortex-core";
import { obsidianConfigSchema, type ObsidianConfig } from "./adapter.js";

/**
 * Obsidian wizard — the only adapter with no secret. The tricky bit is
 * pathToProject, which is an *ordered* array of {prefix, project} rules
 * (first match wins). We collect path prefixes as a list (preserving
 * order) and then collect a project slug per prefix via repeat-per;
 * the preprocess folds the record back into the array the adapter wants.
 */
export const obsidianWizard: WizardModule<ObsidianConfig> = {
  id: "obsidian",
  name: "Obsidian",
  category: "adapter",
  description:
    "Watch an Obsidian vault directory and ingest markdown notes. Path " +
    "prefixes map folder trees to Cortex project slugs.",
  configSchema: obsidianConfigSchema,
  steps: [
    {
      key: "vaultPath",
      prompt: "Absolute path to your Obsidian vault directory",
      type: "text",
      required: true,
    },
    {
      key: "pathPrefixes",
      prompt:
        "Path prefixes (relative to vault root) for project routing, highest priority first. Blank = no routing rules.",
      type: "list",
    },
    {
      key: "pathToProject",
      prompt: "Cortex project slug for each prefix",
      type: "repeat-per",
      source: "pathPrefixes",
      sub: [
        {
          key: "__value",
          prompt: "Cortex project slug",
          type: "text",
          required: true,
          pattern: /^[a-z0-9-]+$/,
          patternHint: "lowercase letters, digits, and hyphens",
        },
      ],
    },
    {
      key: "defaultProject",
      prompt: "Default project slug when no prefix matches (optional)",
      type: "text",
      defaultValue: "",
    },
    {
      key: "maxFileBytes",
      prompt: "Max file size to ingest in bytes (default 1048576 = 1 MiB)",
      type: "text",
      defaultValue: "1048576",
      pattern: /^\d+$/,
    },
  ],
  secrets: [],
  derivedTaxonomy: (state) => {
    const map = (state.pathToProject ?? {}) as Record<string, { __value?: string }>;
    const slugs = new Set<string>();
    for (const v of Object.values(map)) if (v.__value) slugs.add(v.__value);
    if (typeof state.defaultProject === "string" && state.defaultProject) {
      slugs.add(state.defaultProject);
    }
    return { projects: [...slugs].map((slug) => ({ slug })) };
  },
};

const coercedConfigSchema = z.preprocess((val) => {
  if (typeof val !== "object" || val === null) return val;
  const obj = { ...(val as Record<string, unknown>) };

  // maxFileBytes: text → number
  const mfb = obj.maxFileBytes;
  if (typeof mfb === "string" && mfb.length > 0) obj.maxFileBytes = Number(mfb);
  if (mfb === "" || mfb === undefined) delete obj.maxFileBytes;

  // Convert {prefix: {__value: "slug"}} → ordered array of {prefix, project},
  // preserving the order the prefixes were entered in (Object.entries on
  // the record returns insertion order for string keys).
  const raw = obj.pathToProject as Record<string, { __value?: string }> | undefined;
  if (raw && typeof raw === "object") {
    const arr: Array<{ prefix: string; project: string }> = [];
    for (const [prefix, v] of Object.entries(raw)) {
      if (v && typeof v.__value === "string" && v.__value.length > 0) {
        arr.push({ prefix, project: v.__value });
      }
    }
    obj.pathToProject = arr;
  }

  // Collection-only key — drop before validation.
  delete obj.pathPrefixes;

  return obj;
}, obsidianConfigSchema);

(obsidianWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
