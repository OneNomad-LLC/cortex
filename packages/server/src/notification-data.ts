import type { TriggerFlavor } from "@onenomad/cortex-pipeline-notification";
import type { Logger } from "@onenomad/cortex-core";

import { prioritiesWidget } from "./api/widgets/priorities.js";
import { myActionItemsWidget } from "./api/widgets/my-action-items.js";
import { todayMeetingsWidget } from "./api/widgets/today-meetings.js";
import type { WidgetContext } from "./api/types.js";

/**
 * Build template-vars for a notification trigger from real Cortex data.
 *
 * Each flavor maps to one or more widget handlers; output is formatted
 * for the corresponding markdown template under
 * `packages/pipeline-notification/src/prompts/`.
 *
 * Failures degrade to a neutral state (empty list, false flag) rather
 * than throwing — a partial brief with one section missing is more
 * useful than a 500'd notification.
 */
export interface NotificationDataContext {
  ctx: WidgetContext;
  logger: Logger;
}

const DASHBOARD_URL_DEFAULT = "http://localhost:3030/";

export async function buildMorningVars(
  args: NotificationDataContext,
  now: Date,
): Promise<Record<string, unknown>> {
  const date = now.toISOString().slice(0, 10);
  const dashboardUrl = process.env.CORTEX_DASHBOARD_URL ?? DASHBOARD_URL_DEFAULT;

  const [meetingsResult, prioritiesResult] = await Promise.allSettled([
    callTodayMeetings(args),
    callPriorities(args),
  ]);

  const meetingList =
    meetingsResult.status === "fulfilled" ? meetingsResult.value : [];
  const priorityList =
    prioritiesResult.status === "fulfilled" ? prioritiesResult.value : [];

  if (meetingsResult.status === "rejected") {
    args.logger.warn("notification.morning.meetings_failed", {
      error: errorMessage(meetingsResult.reason),
    });
  }
  if (prioritiesResult.status === "rejected") {
    args.logger.warn("notification.morning.priorities_failed", {
      error: errorMessage(prioritiesResult.reason),
    });
  }

  return {
    date,
    meetings: meetingList.length > 0,
    meeting_count: meetingList.length,
    meeting_list: formatBullets(meetingList),
    priorities: priorityList.length > 0,
    priority_list: formatBullets(priorityList),
    // Overnight signals (PR review requests, ticket changes since last
    // brief) are deferred — they need a separate `recent-activity`
    // query against ingestedAt and a per-trigger watermark. For v1 we
    // surface the empty section.
    overnight: false,
    overnight_list: "",
    dashboard_url: dashboardUrl,
  };
}

export async function buildEodVars(
  args: NotificationDataContext,
  now: Date,
): Promise<Record<string, unknown>> {
  const date = now.toISOString().slice(0, 10);
  const dashboardUrl = process.env.CORTEX_DASHBOARD_URL ?? DASHBOARD_URL_DEFAULT;

  const items = await callMyActionItems(args).catch((err) => {
    args.logger.warn("notification.eod.action_items_failed", {
      error: errorMessage(err),
    });
    return [] as ActionItemRow[];
  });

  const todayIso = now.toISOString().slice(0, 10);
  const touched = items.filter((i) => isToday(i.date, todayIso));
  const open = items.filter((i) => i.status !== "done" && i.status !== "dropped");
  const resolved = touched.filter(
    (i) => i.status === "done" || i.status === "dropped",
  );

  return {
    date,
    touched_count: touched.length,
    plural_touched: touched.length === 1 ? "" : "s",
    open_count: open.length,
    resolved_count: resolved.length,
    open_list: formatBullets(
      open.slice(0, 10).map((i) => formatActionItem(i)),
    ),
    dashboard_url: dashboardUrl,
  };
}

/**
 * Pre-meeting brief — placeholder for now. Real implementation needs
 * the calendar event id threaded through to call upcoming-briefs with
 * a single-event filter; that data plumbing is separate from morning /
 * eod since pre-meeting fires per-event, not per-day.
 */
export function buildPreMeetingPlaceholder(
  now: Date,
): Record<string, unknown> {
  const dashboardUrl = process.env.CORTEX_DASHBOARD_URL ?? DASHBOARD_URL_DEFAULT;
  return {
    event_title: "(scheduled meeting)",
    minutes_until: 30,
    start_time: now.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    }),
    attendee_summary: "(attendees pending calendar wiring)",
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

/**
 * Wrapper around the placeholder dispatch from the CLI / scheduler so
 * the right builder fires for the right flavor. Pre-meeting still
 * returns the placeholder; calling code can override per-event.
 */
export async function buildVarsForFlavor(
  flavor: TriggerFlavor,
  args: NotificationDataContext,
  now: Date,
): Promise<Record<string, unknown>> {
  if (flavor === "morning") return buildMorningVars(args, now);
  if (flavor === "eod") return buildEodVars(args, now);
  return buildPreMeetingPlaceholder(now);
}

// ---- Internal: widget calls + formatting ----------------------------

interface ActionItemRow {
  content: string;
  status: string;
  due?: string;
  date?: string;
  project?: string | string[];
  owner?: string;
}

async function callTodayMeetings(args: NotificationDataContext): Promise<string[]> {
  const query = new URLSearchParams();
  const out = await todayMeetingsWidget.handler(query, args.ctx);
  return (out.rows ?? []).map((row) => {
    const time = row.allDay
      ? "all-day"
      : new Date(row.startIso).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        });
    const attendees =
      row.attendees && row.attendees.length > 0
        ? ` — ${row.attendees.slice(0, 3).join(", ")}${row.attendees.length > 3 ? "…" : ""}`
        : "";
    return `${time}: ${row.title}${attendees}`;
  });
}

async function callPriorities(args: NotificationDataContext): Promise<string[]> {
  const query = new URLSearchParams();
  const out = await prioritiesWidget.handler(query, args.ctx);
  return (out.rows ?? []).slice(0, 8).map((row) => {
    const reason = row.reason ? ` (${row.reason.replace(/-/g, " ")})` : "";
    const due = row.due ? ` — due ${row.due}` : "";
    const project = row.project
      ? ` [${Array.isArray(row.project) ? row.project.join(", ") : row.project}]`
      : "";
    return `${row.content}${project}${due}${reason}`;
  });
}

async function callMyActionItems(
  args: NotificationDataContext,
): Promise<ActionItemRow[]> {
  // my-action-items widget returns a flat list of action items in the
  // shape we need for EOD. We pull a generous limit so 'touched today'
  // resolves correctly even when most items aren't due today.
  const query = new URLSearchParams();
  query.set("limit", "100");
  query.set("includeDone", "true");
  const out = (await myActionItemsWidget.handler(query, args.ctx)) as {
    rows?: Array<{
      content?: string;
      status?: string;
      due?: string;
      date?: string;
      project?: string | string[];
      owner?: string;
    }>;
  };
  return (out.rows ?? []).map((r) => ({
    content: r.content ?? "",
    status: r.status ?? "open",
    ...(r.due ? { due: r.due } : {}),
    ...(r.date ? { date: r.date } : {}),
    ...(r.project !== undefined ? { project: r.project } : {}),
    ...(r.owner ? { owner: r.owner } : {}),
  }));
}

function formatActionItem(item: ActionItemRow): string {
  const due = item.due ? ` — due ${item.due}` : "";
  const project = item.project
    ? ` [${Array.isArray(item.project) ? item.project.join(", ") : item.project}]`
    : "";
  return `${item.content}${project}${due}`;
}

function formatBullets(lines: readonly string[]): string {
  return lines.map((l) => `• ${l}`).join("\n");
}

function isToday(iso: string | undefined, todayIso: string): boolean {
  if (!iso) return false;
  return iso.slice(0, 10) === todayIso;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
