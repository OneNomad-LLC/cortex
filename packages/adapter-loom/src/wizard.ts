import { z } from "zod";
import type { WizardModule } from "@onenomad/przm-cortex-core";
import { loomConfigSchema, type LoomConfig } from "./adapter.js";

export const loomWizard: WizardModule<LoomConfig> = {
  id: "loom",
  name: "Loom",
  category: "adapter",
  description:
    "Ingest Loom recordings and their transcripts as meetings. Each " +
    "folder can be mapped to a Cortex project slug.",
  configSchema: loomConfigSchema,
  steps: [
    {
      key: "workspace",
      prompt: "Loom workspace slug (the part after loom.com/workspaces/)",
      type: "text",
      required: true,
    },
    {
      key: "folders",
      prompt:
        "Folder ids to sync (comma-separated). Blank = every folder the key can see.",
      type: "list",
    },
    {
      key: "folderToProject",
      prompt: "Cortex project slug for each folder",
      type: "repeat-per",
      source: "folders",
      sub: [
        {
          key: "__value",
          prompt: "Cortex project slug (blank to skip)",
          type: "text",
          pattern: /^[a-z0-9-]*$/,
          patternHint: "lowercase letters, digits, and hyphens — or blank",
        },
      ],
    },
    {
      key: "defaultProject",
      prompt: "Default project slug when no folder mapping matches (optional)",
      type: "text",
      defaultValue: "",
    },
    {
      key: "skipWithoutTranscript",
      prompt: "Skip recordings that don't yet have a transcript?",
      type: "boolean",
      defaultValue: true,
    },
    {
      key: "pageSize",
      prompt: "Recordings per API call (1-200, default 50)",
      type: "text",
      defaultValue: "50",
      pattern: /^\d+$/,
    },
    {
      key: "maxRecordingsPerRun",
      prompt: "Max recordings per sync run (0 = unlimited)",
      type: "text",
      defaultValue: "0",
      pattern: /^\d+$/,
    },
  ],
  secrets: [
    {
      envVar: "LOOM_API_KEY",
      prompt: "Loom API key (create at loom.com → Preferences → Workspace Settings → Developers)",
      type: "password",
      required: true,
    },
  ],
  derivedTaxonomy: (state) => {
    const map = (state.folderToProject ?? {}) as Record<string, { __value?: string }>;
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
  for (const k of ["pageSize", "maxRecordingsPerRun"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) obj[k] = Number(v);
    if (v === "" || v === undefined) delete obj[k];
  }
  const raw = obj.folderToProject as Record<string, { __value?: string }> | undefined;
  if (raw && typeof raw === "object") {
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.__value === "string" && v.__value.length > 0) flat[k] = v.__value;
    }
    obj.folderToProject = flat;
  }
  return obj;
}, loomConfigSchema);

(loomWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
