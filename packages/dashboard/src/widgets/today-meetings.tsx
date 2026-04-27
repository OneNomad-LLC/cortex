import { fetchWidgetServer } from "@/lib/api";

export interface MeetingRow {
  id: string;
  calendarId: string;
  title: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  location?: string;
  organizer?: string;
  attendees: string[];
  meetingUrl?: string;
  htmlLink?: string;
}

export interface TodayMeetingsData {
  generatedAt: string;
  calendars: string[];
  rows: MeetingRow[];
  note?: string;
}

export async function TodayMeetingsWidget({
  calendars,
  workspace,
}: {
  calendars?: string;
  workspace?: string;
}): Promise<React.JSX.Element> {
  let data: TodayMeetingsData | undefined;
  let error: string | undefined;
  try {
    const params: Record<string, string | number> = {};
    if (calendars) params.calendars = calendars;
    if (workspace) params.workspace = workspace;
    data = await fetchWidgetServer<TodayMeetingsData>(
      "today-meetings",
      params,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Today</h2>
        {data && data.rows.length > 0 && (
          <span className="text-xs text-neutral-500">
            {data.rows.length} meeting{data.rows.length === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t reach the Cortex API: {error}
        </p>
      )}

      {data?.note && data.rows.length === 0 && (
        <p className="text-sm text-neutral-500">{data.note}</p>
      )}

      {data && data.rows.length > 0 && (
        <ul className="space-y-2">
          {data.rows.map((row) => {
            const now = new Date(data.generatedAt).getTime();
            const start = new Date(row.startIso).getTime();
            const end = new Date(row.endIso).getTime();
            const live = now >= start && now < end;
            return (
              <li
                key={`${row.calendarId}:${row.id}`}
                className={`rounded-md border px-3 py-2 ${
                  live
                    ? "border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/30"
                    : "border-neutral-100 dark:border-neutral-800"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {row.title}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {formatWindow(row)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-neutral-500">
                  {live && (
                    <span className="font-medium text-emerald-700 dark:text-emerald-400">
                      Happening now
                    </span>
                  )}
                  {row.organizer && <span>{row.organizer}</span>}
                  {row.attendees.length > 0 && (
                    <span>
                      with{" "}
                      {row.attendees.slice(0, 3).join(", ")}
                      {row.attendees.length > 3
                        ? ` +${row.attendees.length - 3}`
                        : ""}
                    </span>
                  )}
                  {row.location && <span>{row.location}</span>}
                  {row.meetingUrl && (
                    <a
                      className="font-medium text-blue-600 underline underline-offset-2 dark:text-blue-400"
                      href={row.meetingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Join
                    </a>
                  )}
                  {row.htmlLink && !row.meetingUrl && (
                    <a
                      className="underline underline-offset-2"
                      href={row.htmlLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      open
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function formatWindow(row: MeetingRow): string {
  if (row.allDay) return "all day";
  const start = new Date(row.startIso);
  const end = new Date(row.endIso);
  if (Number.isNaN(start.getTime())) return row.startIso;
  const fmt = (d: Date): string =>
    d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  if (Number.isNaN(end.getTime())) return fmt(start);
  return `${fmt(start)} – ${fmt(end)}`;
}
