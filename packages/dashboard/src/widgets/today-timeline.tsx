"use client";

import * as React from "react";
import { CalendarClock, CheckCircle2, AlertOctagon, Lightbulb, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Mirrors `TodayTimelineOutput` server-side. Repeated here rather than
// importing from the server package — the dashboard shouldn't depend on
// server internals.
export interface TimelineRow {
  time: string | null;
  bucket: "overdue" | "now" | "today";
  type: "meeting" | "action_item" | "decision";
  title: string;
  urgency: "high" | "medium" | "low";
  briefReady?: boolean;
  due?: string;
  project?: string;
  source?: { type: "meeting" | "memory"; id: string };
  reason?: "overdue" | "due-soon" | "just-nudged" | "fresh-decision";
  url?: string;
}

export interface TodayTimelineOutput {
  generatedAt: string;
  workspace: string;
  rows: TimelineRow[];
  endOfDayPrompt?: { reason: "soon" | "now"; openCommitments: number };
}

export function TodayTimeline({ data }: { data: TodayTimelineOutput }): React.JSX.Element {
  const { overdue, now, today } = bucketize(data.rows);

  if (data.rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Today is clear</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No meetings, no action items pulled to the top, no fresh decisions in the last 24h.
          Either you&apos;re truly caught up — or check that your adapters are syncing under
          <code className="mx-1 font-mono text-xs">/status</code>.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {data.endOfDayPrompt && (
        <EndOfDayBanner prompt={data.endOfDayPrompt} />
      )}
      {overdue.length > 0 && (
        <TimelineSection
          title="Overdue"
          tone="overdue"
          icon={<AlertOctagon className="h-4 w-4 text-destructive" />}
          rows={overdue}
        />
      )}
      {now.length > 0 && (
        <TimelineSection
          title="Now"
          tone="now"
          icon={<CalendarClock className="h-4 w-4" />}
          rows={now}
        />
      )}
      {today.length > 0 && (
        <TimelineSection
          title="Today"
          tone="today"
          icon={<Lightbulb className="h-4 w-4 text-muted-foreground" />}
          rows={today}
        />
      )}
    </div>
  );
}

function bucketize(rows: TimelineRow[]): {
  overdue: TimelineRow[];
  now: TimelineRow[];
  today: TimelineRow[];
} {
  return {
    overdue: rows.filter((r) => r.bucket === "overdue"),
    now: rows.filter((r) => r.bucket === "now"),
    today: rows.filter((r) => r.bucket === "today"),
  };
}

function TimelineSection({
  title,
  tone,
  icon,
  rows,
}: {
  title: string;
  tone: "overdue" | "now" | "today";
  icon: React.ReactNode;
  rows: TimelineRow[];
}): React.JSX.Element {
  return (
    <section>
      <header className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{title}</span>
        <span className="text-xs text-muted-foreground/70">({rows.length})</span>
      </header>
      <ul className="space-y-2">
        {rows.map((row, i) => (
          <li key={`${row.source?.type ?? "row"}-${row.source?.id ?? i}`}>
            <TimelineRowItem row={row} tone={tone} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function TimelineRowItem({
  row,
  tone,
}: {
  row: TimelineRow;
  tone: "overdue" | "now" | "today";
}): React.JSX.Element {
  const toneClasses = {
    overdue: "border-destructive/40 bg-destructive/5",
    now: "border-primary/40 bg-primary/5 font-medium",
    today: "border-border bg-card",
  }[tone];

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md border px-4 py-3 transition",
        toneClasses,
      )}
    >
      <RowIcon type={row.type} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm">{row.title}</span>
          {row.briefReady && (
            <Badge variant="secondary" className="text-[10px] uppercase">
              brief ready
            </Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {row.time && <span className="font-mono">{formatTime(row.time)}</span>}
          {row.due && <span>due {formatRelative(row.due)}</span>}
          {row.project && (
            <Badge variant="outline" className="text-[10px]">
              {row.project}
            </Badge>
          )}
          {row.reason && (
            <span className="italic">{row.reason.replace(/-/g, " ")}</span>
          )}
        </div>
      </div>
      {row.url && (
        <a
          href={row.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Open"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      )}
    </div>
  );
}

function RowIcon({ type }: { type: TimelineRow["type"] }): React.JSX.Element {
  if (type === "meeting") {
    return <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  if (type === "action_item") {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  return <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
}

function EndOfDayBanner({
  prompt,
}: {
  prompt: NonNullable<TodayTimelineOutput["endOfDayPrompt"]>;
}): React.JSX.Element {
  const message =
    prompt.reason === "now"
      ? `End of day. ${prompt.openCommitments} open commitment${prompt.openCommitments === 1 ? "" : "s"} still on the timeline — knock them out, push, or move them.`
      : `Wrap up: ${prompt.openCommitments} open commitment${prompt.openCommitments === 1 ? "" : "s"} left for today.`;
  return (
    <div className="rounded-md border border-amber-300/60 bg-amber-50 p-4 text-sm dark:border-amber-700/50 dark:bg-amber-950/20">
      <strong className="block text-amber-900 dark:text-amber-200">
        {prompt.reason === "now" ? "EOD" : "EOD soon"}
      </strong>
      <p className="mt-1 text-amber-800 dark:text-amber-300">{message}</p>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ms = d.getTime() - Date.now();
  const minutes = Math.round(ms / 60_000);
  if (Math.abs(minutes) < 60) {
    if (minutes < 0) return `${Math.abs(minutes)}m ago`;
    return `in ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) {
    if (hours < 0) return `${Math.abs(hours)}h ago`;
    return `in ${hours}h`;
  }
  const days = Math.round(hours / 24);
  if (days < 0) return `${Math.abs(days)}d ago`;
  return `in ${days}d`;
}
