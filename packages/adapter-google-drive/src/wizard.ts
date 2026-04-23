import { z } from "zod";
import type { WizardModule } from "@onenomad/cortex-core";
import {
  googleDriveConfigSchema,
  type GoogleDriveConfig,
} from "./adapter.js";

export const googleDriveWizard: WizardModule<GoogleDriveConfig> = {
  id: "google-drive",
  name: "Google Drive",
  category: "adapter",
  description:
    "Ingest Google Docs from specific Drive folders. Run " +
    "`cortex google-login` first to authorize.",
  configSchema: googleDriveConfigSchema,
  steps: [
    {
      key: "folderIds",
      prompt:
        "Drive folder ids to scan (comma-separated). Find the id in the folder URL: drive.google.com/drive/folders/<ID>",
      type: "list",
      required: true,
    },
    {
      key: "folderToProject",
      prompt: "Cortex project slug for each folder",
      type: "repeat-per",
      source: "folderIds",
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
      key: "pageSize",
      prompt: "Files per API call (1-1000)",
      type: "text",
      defaultValue: "100",
      pattern: /^\d+$/,
    },
    {
      key: "maxFilesPerRun",
      prompt: "Max files per sync run (0 = unlimited)",
      type: "text",
      defaultValue: "0",
      pattern: /^\d+$/,
    },
  ],
  secrets: [],
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
  for (const k of ["pageSize", "maxFilesPerRun"]) {
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
}, googleDriveConfigSchema);

(googleDriveWizard as { configSchema: z.ZodTypeAny }).configSchema =
  coercedConfigSchema;
