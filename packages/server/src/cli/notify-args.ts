import type { TriggerFlavor, TemplateName } from "@onenomad/cortex-pipeline-notification";

/**
 * Pure-logic half of `cortex notify`. Lives in its own file so tests
 * can import without dragging notify.ts → openIdempotencyStore →
 * node:sqlite into the vitest transform graph (vite 5.x mishandles the
 * node:* prefix; same workaround as cache-sqlite).
 */

export interface NotifyArgs {
  flavor: TriggerFlavor;
  dryRun: boolean;
  channel: string;
}

export function parseNotifyArgs(
  argv: readonly string[],
): NotifyArgs | { error: string } {
  if (argv.length === 0) {
    return {
      error:
        "cortex notify: flavor required. Try `cortex notify morning|pre-meeting|eod [--dry-run] [--channel=@user]`",
    };
  }
  const [flavorRaw, ...rest] = argv;
  if (flavorRaw !== "morning" && flavorRaw !== "pre-meeting" && flavorRaw !== "eod") {
    return { error: `cortex notify: unknown flavor '${flavorRaw}'. Use morning|pre-meeting|eod.` };
  }
  const opts: NotifyArgs = {
    flavor: flavorRaw,
    dryRun: false,
    channel: "@self",
  };
  for (const flag of rest) {
    if (flag === "--dry-run") opts.dryRun = true;
    else if (flag.startsWith("--channel=")) opts.channel = flag.slice("--channel=".length);
    else return { error: `cortex notify: unknown flag '${flag}'` };
  }
  return opts;
}

export function flavorToTemplate(flavor: TriggerFlavor): TemplateName {
  if (flavor === "morning") return "morning-brief";
  if (flavor === "pre-meeting") return "pre-meeting-brief";
  return "eod-capture";
}

export function buildTriggerId(flavor: TriggerFlavor, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  if (flavor === "morning") return `morning-brief:${day}`;
  if (flavor === "eod") return `eod-capture:${day}`;
  // Pre-meeting needs an event id which the manual CLI doesn't have —
  // generate a transient triggerId from minute-precision so the user
  // can fire+see-message but doesn't accidentally dedupe across a
  // calendar reschedule. Cron path will use real eventIds.
  const minute = now.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
  return `pre-meeting-manual:${minute}`;
}

export function buildPlaceholderVars(flavor: TriggerFlavor, now: Date): Record<string, unknown> {
  const dashboardUrl = "http://localhost:3030/";
  const date = now.toISOString().slice(0, 10);
  if (flavor === "morning") {
    return {
      date,
      meetings: false,
      meeting_count: 0,
      meeting_list: "",
      priorities: false,
      priority_list: "",
      overnight: false,
      overnight_list: "",
      dashboard_url: dashboardUrl,
    };
  }
  if (flavor === "pre-meeting") {
    return {
      event_title: "Sample meeting",
      minutes_until: 30,
      start_time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      attendee_summary: "(no attendees resolved — manual trigger)",
      prior_meetings: false,
      prior_meetings_list: "",
      open_commitments: false,
      commitments_list: "",
      suggested_questions: false,
      questions_list: "",
      event_url: "",
      dashboard_url: dashboardUrl,
    };
  }
  return {
    date,
    touched_count: 0,
    plural_touched: "s",
    open_count: 0,
    resolved_count: 0,
    open_list: "",
    dashboard_url: dashboardUrl,
  };
}
