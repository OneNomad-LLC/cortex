import { z } from "zod";
import type { WizardModule } from "@cortex/core";
import {
  googleCalendarConfigSchema,
  type GoogleCalendarConfig,
} from "./adapter.js";

export const googleCalendarWizard: WizardModule<GoogleCalendarConfig> = {
  id: "google-calendar",
  name: "Google Calendar",
  category: "adapter",
  description:
    "Ingest calendar events for pre-meeting briefs and recap generation. " +
    "Run `cortex google-login` first to authorize.",
  configSchema: googleCalendarConfigSchema,
  steps: [
    {
      key: "calendars",
      prompt:
        "Calendar ids to sync (comma-separated, or 'primary' for the default)",
      type: "list",
    },
    {
      key: "calendarToProject",
      prompt: "Cortex project slug for each calendar",
      type: "repeat-per",
      source: "calendars",
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
      prompt: "Default project slug when no calendar mapping matches (optional)",
      type: "text",
      defaultValue: "",
    },
    {
      key: "lookAheadDays",
      prompt: "Future window in days (for pre-meeting briefs)",
      type: "text",
      defaultValue: "14",
      pattern: /^\d+$/,
    },
    {
      key: "lookBackDays",
      prompt: "Past window in days (for the first run)",
      type: "text",
      defaultValue: "1",
      pattern: /^\d+$/,
    },
    {
      key: "pageSize",
      prompt: "Events per API call (1-2500)",
      type: "text",
      defaultValue: "250",
      pattern: /^\d+$/,
    },
  ],
  secrets: [],
  derivedTaxonomy: (state) => {
    const map = (state.calendarToProject ?? {}) as Record<string, { __value?: string }>;
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
  for (const k of ["lookAheadDays", "lookBackDays", "pageSize"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) obj[k] = Number(v);
    if (v === "" || v === undefined) delete obj[k];
  }
  const raw = obj.calendarToProject as Record<string, { __value?: string }> | undefined;
  if (raw && typeof raw === "object") {
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.__value === "string" && v.__value.length > 0) flat[k] = v.__value;
    }
    obj.calendarToProject = flat;
  }
  // Default calendars to ["primary"] if the user left the list blank.
  if (Array.isArray(obj.calendars) && obj.calendars.length === 0) {
    obj.calendars = ["primary"];
  }
  return obj;
}, googleCalendarConfigSchema);

(googleCalendarWizard as { configSchema: z.ZodTypeAny }).configSchema =
  coercedConfigSchema;
