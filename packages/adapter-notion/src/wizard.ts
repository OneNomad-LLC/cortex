import { z } from "zod";
import type { WizardModule } from "@onenomad/cortex-core";
import { notionConfigSchema, type NotionConfig } from "./adapter.js";

export const notionWizard: WizardModule<NotionConfig> = {
  id: "notion",
  name: "Notion",
  category: "adapter",
  description:
    "Ingest Notion pages from one or more databases. Each database can " +
    "be mapped to a Cortex project slug.",
  configSchema: notionConfigSchema,
  steps: [
    {
      key: "databases",
      prompt:
        "Notion database ids to sync (comma-separated, each 32 hex chars)",
      type: "list",
      itemPattern: /^[A-Fa-f0-9-]+$/,
    },
    {
      key: "databaseToProject",
      prompt: "Cortex project slug for each database",
      type: "repeat-per",
      source: "databases",
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
      key: "pages",
      prompt:
        "Extra standalone page ids (optional, comma-separated)",
      type: "list",
      itemPattern: /^[A-Fa-f0-9-]+$/,
    },
    {
      key: "defaultProject",
      prompt: "Default project slug when no mapping matches (optional)",
      type: "text",
      defaultValue: "",
    },
    {
      key: "pageSize",
      prompt: "Pages per API call (1-100, default 50)",
      type: "text",
      defaultValue: "50",
      pattern: /^\d+$/,
    },
    {
      key: "maxPagesPerRun",
      prompt: "Max pages per sync run (0 = unlimited)",
      type: "text",
      defaultValue: "0",
      pattern: /^\d+$/,
    },
  ],
  secrets: [
    {
      envVar: "NOTION_API_KEY",
      prompt:
        "Notion integration secret (create at notion.so/my-integrations)",
      type: "password",
      required: true,
    },
  ],
  derivedTaxonomy: (state) => {
    const map = (state.databaseToProject ?? {}) as Record<string, { __value?: string }>;
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
  for (const k of ["pageSize", "maxPagesPerRun"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) obj[k] = Number(v);
    if (v === "" || v === undefined) delete obj[k];
  }
  const raw = obj.databaseToProject as Record<string, { __value?: string }> | undefined;
  if (raw && typeof raw === "object") {
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.__value === "string" && v.__value.length > 0) flat[k] = v.__value;
    }
    obj.databaseToProject = flat;
  }
  return obj;
}, notionConfigSchema);

(notionWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
