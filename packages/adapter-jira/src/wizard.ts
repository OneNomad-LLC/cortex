import { z } from "zod";
import type { WizardModule } from "@onenomad/przm-cortex-core";
import { jiraConfigSchema, type JiraConfig } from "./adapter.js";

/**
 * Declarative wizard spec for Jira. Consumed by the CLI runner
 * (`cortex add jira`) and later by the dashboard's module catalog form
 * renderer. Collects workspace + project keys + per-project engagement
 * context tuples, plus shared Atlassian credentials into .env.
 *
 * Shape of the `state` object the runner assembles:
 *   {
 *     workspace: string,
 *     projects: string[],                        // from a "list" step
 *     projectKeyToContext: {                     // from a "repeat-per" step
 *       [projectKey]: {
 *         engagement?: string,
 *         subBrand?: string,
 *         project: string,
 *         team?: string,
 *       }
 *     },
 *     jql: string,
 *     pageSize: number,
 *     maxIssuesPerRun: number,
 *     projectToCortex: {},                       // defaulted empty
 *   }
 */
export const jiraWizard: WizardModule<JiraConfig> = {
  id: "jira",
  name: "Jira",
  category: "adapter",
  description:
    "Ingest Jira issues and comments from one or more projects. Each " +
    "project can be tagged with an engagement + sub-brand + Cortex project " +
    "so memories carry the full context tuple.",
  configSchema: jiraConfigSchema,
  steps: [
    {
      key: "workspace",
      prompt:
        "Atlassian workspace subdomain (the <sub> in <sub>.atlassian.net)",
      type: "text",
      required: true,
      pattern: /^[a-z0-9-]+$/i,
      patternHint: "letters, digits, and hyphens only",
    },
    {
      key: "projects",
      prompt: "Jira project keys to sync (comma-separated, e.g. ENG, OPS)",
      type: "list",
      required: true,
      itemPattern: /^[A-Za-z0-9_]+$/,
    },
    {
      key: "projectKeyToContext",
      prompt: "Engagement context for each Jira project",
      type: "repeat-per",
      source: "projects",
      sub: [
        {
          key: "engagement",
          prompt: "Engagement slug (e.g. acme-corp) — optional, press Enter to skip",
          type: "text",
        },
        {
          key: "subBrand",
          prompt: "Sub-brand slug (e.g. alpha-retail) — optional",
          type: "text",
        },
        {
          key: "project",
          prompt: "Cortex project slug (required, becomes the `project` tag)",
          type: "text",
          required: true,
          pattern: /^[a-z0-9-]+$/,
          patternHint: "lowercase letters, digits, and hyphens",
        },
        {
          key: "team",
          prompt: "Team slug (e.g. alpha) — optional",
          type: "text",
        },
      ],
    },
    {
      key: "jql",
      prompt:
        "Extra JQL filter (optional — e.g. 'resolution = Unresolved' or 'updated >= -30d')",
      type: "text",
      defaultValue: "",
    },
    {
      key: "pageSize",
      prompt: "Issues per API call (1-100, default 50)",
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
    // Placeholder so the Zod schema passes — projectToCortex is empty by
    // default because the rich projectKeyToContext path replaces it.
    {
      key: "projectToCortex",
      prompt: "",
      type: "text",
      defaultValue: "",
    },
  ],
  secrets: [
    {
      envVar: "ATLASSIAN_EMAIL",
      prompt: "Your Atlassian account email (used for Basic auth)",
      type: "text",
      required: true,
    },
    {
      envVar: "ATLASSIAN_API_TOKEN",
      prompt:
        "Atlassian API token (create at id.atlassian.com — never shared in chat)",
      type: "password",
      required: true,
    },
  ],
  derivedTaxonomy: (state) => {
    // Promote every Cortex project slug from projectKeyToContext to
    // projects.local.yaml so tools see them as first-class projects.
    const contexts = (state.projectKeyToContext ?? {}) as Record<
      string,
      { project?: string }
    >;
    const slugs = new Set<string>();
    for (const ctx of Object.values(contexts)) {
      if (ctx.project) slugs.add(ctx.project);
    }
    return {
      projects: [...slugs].map((slug) => ({ slug })),
    };
  },
};

// The text runner returns strings for numeric fields; layer a preprocessor
// that coerces pageSize / maxIssuesPerRun to numbers before validation.
const coercedConfigSchema = z.preprocess((val) => {
  if (typeof val !== "object" || val === null) return val;
  const obj = { ...(val as Record<string, unknown>) };
  for (const k of ["pageSize", "maxIssuesPerRun"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) obj[k] = Number(v);
    if (v === "" || v === undefined) delete obj[k];
  }
  // projectToCortex placeholder from the text step isn't meaningful —
  // drop it so the schema's default({}) kicks in.
  if (obj.projectToCortex === "" || obj.projectToCortex === undefined) {
    delete obj.projectToCortex;
  }
  return obj;
}, jiraConfigSchema);

(jiraWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
