import { GoogleAuthClient, readGoogleToken } from "@onenomad/cortex-google-auth";
import type { Widget } from "../types.js";

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

export interface TodayMeetingsOutput {
  generatedAt: string;
  calendars: string[];
  rows: MeetingRow[];
  note?: string;
}

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    optional?: boolean;
  }>;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
}

interface EventsResponse {
  items?: CalendarEvent[];
}

/**
 * Today's meetings — queries Google Calendar live rather than reading from
 * Engram, because:
 *
 *   1. The doc pipeline sets `date = updatedAt`, not event start time, so
 *      filtering ingested events by "today" doesn't work.
 *   2. Calendars change throughout the day (reschedules, cancellations,
 *      new invites); live is the only way to stay accurate.
 *
 * Falls back gracefully to a placeholder message if the user hasn't run
 * `cortex google-login`. Multi-calendar supported via the `calendars`
 * prop in dashboard.yaml — defaults to `primary`.
 *
 * For testing, an override auth factory can be injected via opts so the
 * tests don't need a real token on disk.
 */
export interface TodayMeetingsOpts {
  /** Override the auth client resolution. Used by tests. */
  resolveAuth?: () => Promise<GoogleAuthClient>;
}

export function createTodayMeetingsWidget(
  opts: TodayMeetingsOpts = {},
): Widget<TodayMeetingsOutput> {
  return {
    name: "today-meetings",
    description:
      "Today's meetings from Google Calendar, sorted by start time.",

    async handler(query, ctx) {
      const calendars = parseCalendars(query.get("calendars"));
      const tz = query.get("tz") ?? undefined;

      const now = new Date();
      const { dayStart, dayEnd } = dayWindow(now);

      let auth: GoogleAuthClient;
      try {
        auth = opts.resolveAuth
          ? await opts.resolveAuth()
          : new GoogleAuthClient({ token: await readGoogleToken() });
      } catch (err) {
        ctx.logger.info("widget.today_meetings.no_token", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          generatedAt: now.toISOString(),
          calendars,
          rows: [],
          note:
            "Run `cortex google-login` (with the calendar scope) to see today's meetings.",
        };
      }

      const rows: MeetingRow[] = [];
      for (const calendarId of calendars) {
        const params = new URLSearchParams({
          singleEvents: "true",
          showDeleted: "false",
          orderBy: "startTime",
          timeMin: dayStart.toISOString(),
          timeMax: dayEnd.toISOString(),
          maxResults: "50",
        });
        if (tz) params.set("timeZone", tz);

        try {
          const data = await auth.authorizedFetch<EventsResponse>(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
          );
          for (const event of data.items ?? []) {
            if (event.status === "cancelled") continue;
            const row = shapeEvent(event, calendarId);
            if (row) rows.push(row);
          }
        } catch (err) {
          ctx.logger.warn("widget.today_meetings.calendar_failed", {
            calendarId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      rows.sort((a, b) => a.startIso.localeCompare(b.startIso));

      const out: TodayMeetingsOutput = {
        generatedAt: now.toISOString(),
        calendars,
        rows,
      };
      if (rows.length === 0) {
        out.note = "Nothing on your calendar today.";
      }
      return out;
    },
  };
}

/**
 * Default instance — used when the dashboard API boots without an
 * override. Tests construct their own via `createTodayMeetingsWidget`.
 */
export const todayMeetingsWidget = createTodayMeetingsWidget();

function parseCalendars(raw: string | null): string[] {
  if (!raw) return ["primary"];
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : ["primary"];
}

function dayWindow(now: Date): { dayStart: Date; dayEnd: Date } {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  return { dayStart, dayEnd };
}

function shapeEvent(
  event: CalendarEvent,
  calendarId: string,
): MeetingRow | undefined {
  const startDateTime = event.start?.dateTime;
  const startDate = event.start?.date;
  const endDateTime = event.end?.dateTime;
  const endDate = event.end?.date;

  const startIso = startDateTime ?? startDate ?? "";
  const endIso = endDateTime ?? endDate ?? startIso;
  if (!startIso) return undefined;

  const allDay = !startDateTime && !!startDate;
  const attendees = (event.attendees ?? [])
    .filter((a) => !a.optional && a.email)
    .map((a) => a.displayName ?? a.email!)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const meetingUrl = event.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video",
  )?.uri;

  const row: MeetingRow = {
    id: event.id,
    calendarId,
    title: event.summary?.trim() || "(no title)",
    startIso,
    endIso,
    allDay,
    attendees,
  };
  if (event.location) row.location = event.location;
  const organizer = event.organizer?.displayName ?? event.organizer?.email;
  if (organizer) row.organizer = organizer;
  if (meetingUrl) row.meetingUrl = meetingUrl;
  if (event.htmlLink) row.htmlLink = event.htmlLink;
  return row;
}
