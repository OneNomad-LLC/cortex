import { z } from "zod";
import type { WizardModule } from "@onenomad/cortex-core";
import { slackConfigSchema, type SlackConfig } from "./adapter.js";

export const slackWizard: WizardModule<SlackConfig> = {
  id: "slack",
  name: "Slack",
  category: "adapter",
  description:
    "Ingest Slack threads from explicitly opted-in channels. The bot " +
    "must already be a member of every channel listed.",
  configSchema: slackConfigSchema,
  steps: [
    {
      key: "workspace",
      prompt:
        "Slack workspace slug (the part before .slack.com, used for URL building). Optional.",
      type: "text",
      defaultValue: "",
      pattern: /^[a-z0-9-]*$/i,
    },
    {
      key: "channels",
      prompt:
        "Channel ids to sync as uppercase C-prefixed ids, comma-separated (e.g. C0123ABC, C0456DEF). The bot must already be a member of each.",
      type: "list",
      required: true,
      itemPattern: /^[A-Z0-9]+$/,
    },
    {
      key: "channelToProject",
      prompt: "Cortex project slug for each channel",
      type: "repeat-per",
      source: "channels",
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
      prompt: "Default project slug when no channel mapping matches (optional)",
      type: "text",
      defaultValue: "",
    },
    {
      key: "historyDays",
      prompt: "How many days of history to pull per channel per run (1-365, default 7)",
      type: "text",
      defaultValue: "7",
      pattern: /^\d+$/,
    },
    {
      key: "maxThreadsPerRun",
      prompt: "Max threads per sync run (0 = unlimited, default 100)",
      type: "text",
      defaultValue: "100",
      pattern: /^\d+$/,
    },
  ],
  secrets: [
    {
      envVar: "SLACK_BOT_TOKEN",
      prompt: "Slack bot token (xoxb-...) — create a Slack app with the channels:history + channels:read scopes",
      type: "password",
      required: true,
    },
    {
      envVar: "SLACK_SIGNING_SECRET",
      prompt: "Slack app signing secret (optional — set only if wiring the Slack Events webhook)",
      type: "password",
      required: false,
    },
  ],
  derivedTaxonomy: (state) => {
    const map = (state.channelToProject ?? {}) as Record<string, { __value?: string }>;
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
  for (const k of ["historyDays", "maxThreadsPerRun"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) obj[k] = Number(v);
    if (v === "" || v === undefined) delete obj[k];
  }
  const raw = obj.channelToProject as Record<string, { __value?: string }> | undefined;
  if (raw && typeof raw === "object") {
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.__value === "string" && v.__value.length > 0) flat[k] = v.__value;
    }
    obj.channelToProject = flat;
  }
  return obj;
}, slackConfigSchema);

(slackWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
