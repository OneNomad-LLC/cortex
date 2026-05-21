import { z } from "zod";
import type { WizardModule } from "@onenomad/przm-cortex-core";
import { confluenceConfigSchema, type ConfluenceConfig } from "./adapter.js";

/**
 * Declarative wizard spec for Confluence. Consumed by the CLI runner
 * (`cortex init` / `cortex add confluence`) and later by the dashboard's
 * module catalog form renderer. Collects workspace + spaces + per-space
 * engagement context tuples, plus Atlassian credentials into .env.
 *
 * Shape of the `state` object the runner assembles:
 *   {
 *     workspace: string,
 *     spaces: string[],                     // from a "list" step
 *     spaceToContext: {                     // from a "repeat-per" step
 *       [spaceKey]: {
 *         engagement?: string,
 *         subBrand?: string,
 *         project: string,
 *         team?: string,
 *       }
 *     },
 *     pageSize: number,
 *     maxPagesPerRun: number,
 *     spaceToProject: {},                   // defaulted empty
 *   }
 */
export const confluenceWizard: WizardModule<ConfluenceConfig> = {
  id: "confluence",
  name: "Confluence",
  category: "adapter",
  description:
    "Ingest Confluence pages from one or more spaces. Each space can be " +
    "tagged with an engagement + sub-brand + project so memories carry " +
    "the full context tuple.",
  configSchema: confluenceConfigSchema,
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
      key: "spaces",
      prompt: "Space keys to sync (comma-separated, e.g. ENG, PRODUCT)",
      type: "list",
      required: true,
      itemPattern: /^[A-Za-z0-9_-]+$/,
    },
    {
      key: "spaceToContext",
      prompt: "Engagement context for each space",
      type: "repeat-per",
      source: "spaces",
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
          prompt: "Project slug (required, becomes the `project` tag)",
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
      key: "pageSize",
      prompt: "Pages per API call (1-250, default 50)",
      type: "text",
      defaultValue: "50",
      pattern: /^\d+$/,
    },
    {
      key: "maxPagesPerRun",
      prompt: "Max pages per sync run per space (0 = unlimited)",
      type: "text",
      defaultValue: "0",
      pattern: /^\d+$/,
    },
    // Placeholder so the Zod schema passes — spaceToProject is empty by
    // default because the rich spaceToContext path replaces it.
    {
      key: "spaceToProject",
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
    // Promote every project slug from spaceToContext to
    // projects.local.yaml so tools see them as first-class projects.
    const contexts = (state.spaceToContext ?? {}) as Record<
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

// The raw step collection emits stringly-typed pageSize / maxPagesPerRun
// because the text runner returns strings. Coerce before handing to
// configSchema by layering a preprocessor. We do that by wrapping the
// schema here; the wizard module exposes the wrapped version so the
// runner's `safeParse` sees numeric values.
const coercedConfigSchema = z.preprocess((val) => {
  if (typeof val !== "object" || val === null) return val;
  const obj = { ...(val as Record<string, unknown>) };
  for (const k of ["pageSize", "maxPagesPerRun"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) obj[k] = Number(v);
    if (v === "" || v === undefined) delete obj[k];
  }
  // spaceToProject default is a record; empty string from the placeholder
  // step isn't meaningful — drop it so the schema's default({}) kicks in.
  if (obj.spaceToProject === "" || obj.spaceToProject === undefined) {
    delete obj.spaceToProject;
  }
  return obj;
}, confluenceConfigSchema);

// Swap in the coerced schema at runtime so numeric strings from text
// prompts (pageSize, maxPagesPerRun) pass validation.
(confluenceWizard as { configSchema: z.ZodTypeAny }).configSchema =
  coercedConfigSchema;
