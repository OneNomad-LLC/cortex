import { z } from "zod";
import type { WizardModule } from "@onenomad/cortex-core";
import { bitbucketConfigSchema, type BitbucketConfig } from "./adapter.js";

/**
 * Bitbucket shares ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN with Confluence
 * and Jira. The config-mutation service dedupes .env keys on write, so
 * running the Bitbucket wizard after Confluence/Jira won't duplicate
 * those secret lines.
 */
export const bitbucketWizard: WizardModule<BitbucketConfig> = {
  id: "bitbucket",
  name: "Bitbucket",
  category: "adapter",
  description:
    "Ingest source files from Bitbucket Cloud repos. Include/exclude " +
    "globs keep the index scoped; each repo can be mapped to a Cortex " +
    "project slug.",
  configSchema: bitbucketConfigSchema,
  steps: [
    {
      key: "workspace",
      prompt: "Bitbucket workspace slug (from bitbucket.org/<workspace>/)",
      type: "text",
      required: true,
      pattern: /^[a-z0-9-]+$/i,
      patternHint: "letters, digits, and hyphens",
    },
    {
      key: "repos",
      prompt: "Repository slugs to sync (comma-separated)",
      type: "list",
      required: true,
      itemPattern: /^[A-Za-z0-9._-]+$/,
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
      prompt: "Branch to sync",
      type: "text",
      defaultValue: "main",
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
      envVar: "ATLASSIAN_EMAIL",
      prompt: "Your Atlassian account email (same one used for Confluence / Jira)",
      type: "text",
      required: true,
    },
    {
      envVar: "ATLASSIAN_API_TOKEN",
      prompt:
        "Atlassian API token (create at id.atlassian.com — reuse the one from Confluence / Jira)",
      type: "password",
      required: true,
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
}, bitbucketConfigSchema);

(bitbucketWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
