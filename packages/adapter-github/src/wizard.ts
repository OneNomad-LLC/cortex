import { z } from "zod";
import type { WizardModule } from "@onenomad/przm-cortex-core";
import { githubConfigSchema, type GithubConfig } from "./adapter.js";

export const githubWizard: WizardModule<GithubConfig> = {
  id: "github",
  name: "GitHub",
  category: "adapter",
  description:
    "Ingest GitHub repos into Cortex. The default `dossier` mode produces " +
    "a 1 brief + N decisions + N references summary per repo — what cortex " +
    "KNOWS about the project, not raw source. Switch to `full` for vector " +
    "search over every file, or `both` for both.",
  configSchema: githubConfigSchema,
  steps: [
    {
      key: "repos",
      prompt: "Repositories to sync as owner/repo, comma-separated (e.g. acme/web, acme/api)",
      type: "list",
      required: true,
      itemPattern: /^[^/]+\/[^/]+$/,
    },
    {
      key: "mode",
      prompt:
        "Default ingestion mode for each repo — dossier is recommended (a " +
        "concise summary that's cheap to keep fresh). Pick `full` only if " +
        "you need vector search over raw source files; `both` runs both " +
        "pipelines.",
      type: "select",
      choices: [
        { value: "dossier", label: "dossier (recommended)" },
        { value: "full", label: "full" },
        { value: "both", label: "both" },
      ],
      defaultValue: "dossier",
    },
    {
      key: "repoToProject",
      prompt: "Cortex project slug for each repo",
      type: "repeat-per",
      source: "repos",
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
      key: "repoModes",
      prompt: "Per-repo mode override (blank = use the adapter default)",
      type: "repeat-per",
      source: "repos",
      sub: [
        {
          key: "__value",
          prompt: "Mode override (blank to use adapter default)",
          type: "select",
          choices: [
            { value: "", label: "use adapter default" },
            { value: "dossier", label: "dossier" },
            { value: "full", label: "full" },
            { value: "both", label: "both" },
          ],
          defaultValue: "",
        },
      ],
    },
    {
      key: "branch",
      prompt:
        "Branch to sync (blank = each repo's default branch)",
      type: "text",
      defaultValue: "",
    },
    {
      key: "defaultProject",
      prompt: "Default project slug when no repo mapping matches (optional)",
      type: "text",
      defaultValue: "",
    },
    {
      key: "maxFilesPerRun",
      prompt: "Max files to ingest per sync run (0 = unlimited)",
      type: "text",
      defaultValue: "0",
      pattern: /^\d+$/,
    },
  ],
  secrets: [
    {
      envVar: "GITHUB_TOKEN",
      prompt:
        "GitHub personal access token with `contents:read` (or fine-grained equivalent)",
      type: "password",
      required: true,
    },
    {
      envVar: "GITHUB_WEBHOOK_SECRET",
      prompt:
        "Webhook shared secret (optional — set only if wiring GitHub push webhooks)",
      type: "password",
      required: false,
    },
  ],
  derivedTaxonomy: (state) => {
    const map = (state.repoToProject ?? {}) as Record<string, { __value?: string }>;
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
  const mfr = obj.maxFilesPerRun;
  if (typeof mfr === "string" && mfr.length > 0) obj.maxFilesPerRun = Number(mfr);
  if (mfr === "" || mfr === undefined) delete obj.maxFilesPerRun;

  const raw = obj.repoToProject as Record<string, { __value?: string }> | undefined;
  if (raw && typeof raw === "object") {
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.__value === "string" && v.__value.length > 0) flat[k] = v.__value;
    }
    obj.repoToProject = flat;
  }

  // Mirror the same flatten pass for `repoModes` so the wizard's
  // repeat-per shape (`{ __value: "dossier" }`) collapses to the
  // adapter schema's flat `{ "owner/repo": "dossier" }`. Empty
  // overrides drop out entirely; an empty object collapses to undefined
  // so the optional() schema doesn't carry noise.
  const rawModes = obj.repoModes as
    | Record<string, { __value?: string }>
    | undefined;
  if (rawModes && typeof rawModes === "object") {
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawModes)) {
      if (v && typeof v.__value === "string" && v.__value.length > 0) {
        flat[k] = v.__value;
      }
    }
    if (Object.keys(flat).length > 0) obj.repoModes = flat;
    else delete obj.repoModes;
  }
  return obj;
}, githubConfigSchema);

(githubWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
