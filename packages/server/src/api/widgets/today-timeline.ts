import type { Widget, WidgetContext } from "../types.js";
import { todayMeetingsWidget, type MeetingRow } from "./today-meetings.js";
import {
  prioritiesWidget,
  type PriorityRow,
  type PrioritiesOutput,
} from "./priorities.js";
// upcomingBriefsWidget removed in Phase 1B (2026-05-09) — its
// briefReady annotation degraded to false on every meeting row.
// today-timeline itself is slated for removal in a follow-up Phase 1B
// slice; this targeted edit lets the cascade unblock without taking
// the whole timeline down in the same commit.

export type TimelineBucket = "overdue" | "now" | "today";
export type TimelineUrgency = "high" | "medium" | "low";
export type TimelineRowType = "meeting" | "action_item" | "decision";

export interface TimelineRow {
  /** ISO timestamp; null for "no specific time" (action items without due). */
  time: string | null;
  bucket: TimelineBucket;
  type: TimelineRowType;
  title: string;
  urgency: TimelineUrgency;
  /** Meetings only: does upcoming-briefs have a synth-able brief in
   *  cache. Always false post-Phase-1B until briefs come back through
   *  a non-personal-flow surface. */
  briefReady?: boolean;
  /** Action items: due ISO. */
  due?: string;
  /** Project slug (single — falls back to first when memory carries an array). */
  project?: string;
  /** Pointer to the upstream artifact for navigation. */
  source?: { type: "meeting" | "memory"; id: string };
  /** Why the row showed up. Inherited from priorities for action_item/decision rows. */
  reason?: PriorityRow["reason"];
  /** Optional URL to follow (calendar link, source doc URL). */
  url?: string;
}

export interface TodayTimelineOutput {
  generatedAt: string;
  workspace: string;
  rows: TimelineRow[];
  /** End-of-day nudge after 16:00 local: surfaces still-open commitments. */
  endOfDayPrompt?: {
    reason: "soon" | "now";
    openCommitments: number;
  };
}

/**
 * Today timeline aggregator — chronologically merges three existing
 * data planes (today-meetings + priorities + upcoming-briefs) into a
 * single "what should I care about right now" view. Replaces the
 * widget grid as the dashboard root.
 *
 * Aggregation rules:
 *   - meetings: each calendar row → meeting timeline row, time = startIso.
 *     If upcoming-briefs surfaced a brief for the event id, mark
 *     briefReady=true.
 *   - action items: each priority row of type=action_item → action_item
 *     row. time = due (when present), null otherwise. Bucket from due/now:
 *     past-due → overdue, due ≤ 2h → now, due ≤ end-of-day → today, else
 *     bucket=today (still on the radar even if due in N days — no
 *     separate "future" bucket per spec).
 *   - decisions: each priority row of type=decision → decision row. Time
 *     = the memory's `date` (when present, ISO of when it was logged).
 *     Bucket=today (decisions are always informational, not action-gated).
 *
 * Sort order: rows with time first (chronological asc), then null-time
 * rows by urgency desc. Bucket overrides display ordering UI-side; the
 * widget keeps a single sorted array for transport simplicity.
 *
 * endOfDayPrompt fires after local 16:00 — `reason: "soon"` until 18:00,
 * `reason: "now"` thereafter. Counts open action_items in the result set
 * (action_item rows still bucketed as today/overdue at end-of-day).
 */
export const todayTimelineWidget: Widget<TodayTimelineOutput> = {
  name: "today-timeline",
  description:
    "Chronological day-view: meetings + action items + recent decisions merged into a single timeline with overdue/now/today buckets and an end-of-day nudge after 4pm local.",

  async handler(query, ctx) {
    const now = new Date();
    const generatedAt = now.toISOString();
    const workspace = ctx.workspace?.slug ?? "";

    // Forward narrowing params. Most callers won't override; we let the
    // constituent widgets fall back to their defaults when params are
    // absent.
    const meetingsQuery = passthrough(query, ["calendars", "tz"]);
    const prioritiesQuery = passthrough(query, ["owner", "limit", "days"]);

    const [meetings, priorities] = await Promise.all([
      todayMeetingsWidget.handler(meetingsQuery, ctx).catch((err) => {
        ctx.logger.warn("widget.today_timeline.meetings_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { rows: [] as MeetingRow[], generatedAt, calendars: [] };
      }),
      prioritiesWidget.handler(prioritiesQuery, ctx).catch((err) => {
        ctx.logger.warn("widget.today_timeline.priorities_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { rows: [] as PriorityRow[], generatedAt } as PrioritiesOutput;
      }),
    ]);

    // briefByEventId is permanently empty post-Phase-1B until a
    // non-personal-flow brief source replaces upcoming-briefs.
    const briefByEventId = new Map<string, boolean>();

    const rows: TimelineRow[] = [];
    for (const m of meetings.rows ?? []) {
      rows.push(meetingToTimelineRow(m, briefByEventId, now));
    }
    for (const p of priorities.rows ?? []) {
      const tl = priorityToTimelineRow(p, now);
      if (tl) rows.push(tl);
    }

    rows.sort(timelineSort);

    const out: TodayTimelineOutput = { generatedAt, workspace, rows };
    const eod = computeEndOfDayPrompt(now, rows);
    if (eod) out.endOfDayPrompt = eod;
    return out;
  },
};

function passthrough(
  query: URLSearchParams,
  keys: readonly string[],
): URLSearchParams {
  const out = new URLSearchParams();
  for (const k of keys) {
    const v = query.get(k);
    if (v !== null) out.set(k, v);
  }
  return out;
}

function meetingToTimelineRow(
  m: MeetingRow,
  briefIndex: Map<string, boolean>,
  now: Date,
): TimelineRow {
  const start = new Date(m.startIso);
  const minutesUntil = Math.floor((start.getTime() - now.getTime()) / 60_000);
  // Meetings can't be "overdue" in the action-item sense — past meetings
  // bucket to today (they happened, but they're still part of today's
  // narrative for end-of-day debrief).
  let bucket: TimelineBucket;
  if (minutesUntil <= 0 || minutesUntil > 120) bucket = "today";
  else bucket = "now";
  // Urgency: starting ≤30min = high (heads-up), ≤2h = medium, else low.
  let urgency: TimelineUrgency;
  if (minutesUntil <= 30 && minutesUntil >= 0) urgency = "high";
  else if (minutesUntil <= 120 && minutesUntil >= 0) urgency = "medium";
  else urgency = "low";
  const out: TimelineRow = {
    time: m.startIso,
    bucket,
    type: "meeting",
    title: m.title,
    urgency,
    briefReady: briefIndex.has(m.id),
    source: { type: "meeting", id: m.id },
  };
  if (m.htmlLink) out.url = m.htmlLink;
  if (m.meetingUrl) out.url = m.meetingUrl;
  return out;
}

function priorityToTimelineRow(p: PriorityRow, now: Date): TimelineRow | null {
  // Skip rows priorities surfaced that don't fit the timeline shape.
  if (p.type !== "action_item" && p.type !== "decision") return null;

  const project = Array.isArray(p.project) ? p.project[0] : p.project;
  const time = p.due ?? p.date ?? null;
  let bucket: TimelineBucket = "today";
  let urgency: TimelineUrgency = "medium";

  if (p.type === "action_item") {
    if (p.due) {
      const dueAt = new Date(p.due).getTime();
      const diffMs = dueAt - now.getTime();
      if (diffMs < 0) {
        bucket = "overdue";
        urgency = "high";
      } else if (diffMs <= 2 * 3_600_000) {
        bucket = "now";
        urgency = "high";
      } else if (diffMs <= 86_400_000) {
        bucket = "today";
        urgency = "medium";
      } else {
        bucket = "today";
        urgency = "low";
      }
    } else {
      // No due date — surface in today bucket but lower urgency unless
      // priorities tagged it just-nudged (active work).
      bucket = "today";
      urgency = p.reason === "just-nudged" ? "medium" : "low";
    }
  } else {
    // Decisions are heads-up only.
    bucket = "today";
    urgency = "low";
  }

  const row: TimelineRow = {
    time,
    bucket,
    type: p.type as TimelineRowType,
    title: p.content,
    urgency,
    source: { type: "memory", id: p.sourceId },
    reason: p.reason,
  };
  if (project) row.project = project;
  if (p.due) row.due = p.due;
  if (p.url) row.url = p.url;
  return row;
}

function timelineSort(a: TimelineRow, b: TimelineRow): number {
  // Rows with `time` come first (chronological), then null-time rows
  // sorted by urgency desc.
  if (a.time && b.time) return a.time.localeCompare(b.time);
  if (a.time && !b.time) return -1;
  if (!a.time && b.time) return 1;
  return urgencyRank(b.urgency) - urgencyRank(a.urgency);
}

function urgencyRank(u: TimelineUrgency): number {
  if (u === "high") return 2;
  if (u === "medium") return 1;
  return 0;
}

const END_OF_DAY_HOUR_SOON = 16;
const END_OF_DAY_HOUR_NOW = 18;

export function computeEndOfDayPrompt(
  now: Date,
  rows: TimelineRow[],
): TodayTimelineOutput["endOfDayPrompt"] | undefined {
  const hour = now.getHours();
  if (hour < END_OF_DAY_HOUR_SOON) return undefined;
  const reason = hour >= END_OF_DAY_HOUR_NOW ? "now" : "soon";
  // Open commitments = action_items still bucketed today/overdue.
  const open = rows.filter(
    (r) =>
      r.type === "action_item" && (r.bucket === "today" || r.bucket === "overdue"),
  ).length;
  return { reason, openCommitments: open };
}
