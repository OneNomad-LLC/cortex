import { z } from "zod";
import type { WizardModule } from "@onenomad/cortex-core";
import { githubConfigSchema, type GithubConfig } from "./adapter.js";

export const githubWizard: WizardModule<GithubConfig> = {
  id: "github",
  name: "GitHub",
  category: "adapter",
  description:
    "Ingest source files from GitHub repos. Include/exclude globs keep " +
    "the index scoped; each repo can be mapped to a Cortex project slug.",
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
  return obj;
}, githubConfigSchema);

(githubWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
