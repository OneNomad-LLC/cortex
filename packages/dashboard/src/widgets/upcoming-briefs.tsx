import { fetchWidgetServer } from "@/lib/api";

/**
 * Mirrors the `upcomingBriefs` MCP tool output. See ADR-015 on the
 * deliberate type duplication.
 */
export interface UpcomingBriefContext {
  recent_meetings: Array<{ title?: string; date?: string; preview: string }>;
  open_action_items: Array<{ content: string; owner?: string; due?: string }>;
  relevant_docs: Array<{ title?: string; preview: string; url?: string }>;
  recent_decisions: Array<{ content: string; owner?: string }>;
}

export interface UpcomingBriefRow {
  eventId: string;
  title?: string;
  start?: string;
  end?: string;
  attendees?: string[];
  url?: string;
  projectSlug?: string;
  brief?: string;
  context: UpcomingBriefContext;
}

export interface UpcomingBriefsData {
  now: string;
  window: { from: string; to: string };
  events: UpcomingBriefRow[];
  hint?: string;
}

export async function UpcomingBriefsWidget({
  hoursAhead = 24,
  minutesThreshold = 0,
  limit = 3,
  project,
  generateBrief = false,
  workspace,
}: {
  hoursAhead?: number;
  minutesThreshold?: number;
  limit?: number;
  project?: string;
  generateBrief?: boolean;
  workspace?: string;
}): Promise<React.JSX.Element> {
  let data: UpcomingBriefsData | undefined;
  let error: string | undefined;
  try {
    const params: Record<string, string | number> = {
      hoursAhead,
      minutesThreshold,
      limit,
    };
    if (project) params.project = project;
    if (generateBrief) params.generateBrief = "true";
    if (workspace) params.workspace = workspace;
    data = await fetchWidgetServer<UpcomingBriefsData>(
      "upcoming-briefs",
      params,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Upcoming briefs</h2>
        {data && data.events.length > 0 && (
          <span className="text-xs text-neutral-500">
            next {hoursAhead}h
          </span>
        )}
      </header>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t reach the Cortex API: {error}
        </p>
      )}

      {data && data.events.length === 0 && (
        <p className="text-sm text-neutral-500">
          {data.hint ??
            "No upcoming meetings with enough context to brief. Run calendar sync?"}
        </p>
      )}

      {data && data.events.length > 0 && (
        <div className="space-y-4">
          {data.events.map((event) => (
            <EventBrief key={event.eventId} event={event} />
          ))}
        </div>
      )}
    </section>
  );
}

function EventBrief({
  event,
}: {
  event: UpcomingBriefRow;
}): React.JSX.Element {
  const openCount = event.context.open_action_items.length;
  const decisionCount = event.context.recent_decisions.length;

  return (
    <article className="rounded-md border border-neutral-100 px-3 py-2 dark:border-neutral-800">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">
          {event.title ?? "Untitled event"}
        </span>
        <span className="shrink-0 text-xs text-neutral-500">
          {event.start ? formatStart(event.start) : ""}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-2 text-xs text-neutral-500">
        {event.projectSlug && (
          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
            {event.projectSlug}
          </span>
        )}
        {event.attendees && event.attendees.length > 0 && (
          <span>
            {event.attendees.slice(0, 3).join(", ")}
            {event.attendees.length > 3
              ? ` +${event.attendees.length - 3}`
              : ""}
          </span>
        )}
        {event.url && (
          <a
            className="underline underline-offset-2"
            href={event.url}
            target="_blank"
            rel="noreferrer"
          >
            invite
          </a>
        )}
      </div>

      {event.brief && (
        <pre className="mt-2 whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs text-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
          {event.brief}
        </pre>
      )}

      {!event.brief && (openCount > 0 || decisionCount > 0) && (
        <div className="mt-2 space-y-1 text-xs">
          {openCount > 0 && (
            <div>
              <span className="font-medium text-neutral-600 dark:text-neutral-300">
                Open threads ({openCount})
              </span>
              <ul className="mt-0.5 list-disc pl-4 text-neutral-500">
                {event.context.open_action_items.slice(0, 3).map((ai, i) => (
                  <li key={i} className="truncate">
                    {ai.content}
                    {ai.owner ? ` · @${ai.owner}` : ""}
                    {ai.due ? ` · due ${ai.due}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {decisionCount > 0 && (
            <div>
              <span className="font-medium text-neutral-600 dark:text-neutral-300">
                Recent decisions
              </span>
              <ul className="mt-0.5 list-disc pl-4 text-neutral-500">
                {event.context.recent_decisions.slice(0, 2).map((d, i) => (
                  <li key={i} className="truncate">
                    {d.content}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!event.brief && openCount === 0 && decisionCount === 0 && (
        <p className="mt-2 text-xs text-neutral-500">No prior context yet.</p>
      )}
    </article>
  );
}

function formatStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = d.getTime() - Date.now();
  if (diffMs < 0) return "now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60)
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
