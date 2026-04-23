import { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterFactory,
  ClassificationContext,
  ClassifiedItem,
  NormalizedItem,
  ProjectCandidate,
  RawSourceItem,
} from "@onenomad/cortex-core";
import { BaseAdapter } from "@onenomad/cortex-adapter-sdk";
import { GoogleAuthClient, readGoogleToken } from "@onenomad/cortex-google-auth";

export const googleCalendarConfigSchema = z.object({
  /** Calendar ids. "primary" = the authenticated user's main calendar. */
  calendars: z.array(z.string().min(1)).default(["primary"]),
  /** Future window. Events > now+N days skipped. */
  lookAheadDays: z.number().int().min(1).max(365).default(14),
  /** Past window on the first run or when `since` isn't provided. */
  lookBackDays: z.number().int().min(0).max(3650).default(1),
  pageSize: z.number().int().min(1).max(2500).default(250),
  /** Map calendar id → Cortex project slug. */
  calendarToProject: z.record(z.string()).default({}),
  defaultProject: z.string().default(""),
});

export type GoogleCalendarConfig = z.infer<typeof googleCalendarConfigSchema>;

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"] as const;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: true,
  supportsWebhooks: false,
  supportsAttachments: false,
  supportsComments: false,
  supportsRealTime: false,
};

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink: string;
  created: string;
  updated: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string };
  creator?: { email?: string; displayName?: string };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    optional?: boolean;
  }>;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
  recurringEventId?: string;
  iCalUID?: string;
}

interface EventsResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
}

interface RawCalendarItem {
  event: CalendarEvent;
  calendarId: string;
}

export class GoogleCalendarAdapter extends BaseAdapter {
  readonly id = "google-calendar";
  readonly name = "Google Calendar";
  readonly version = "0.1.0";
  readonly configSchema = googleCalendarConfigSchema;
  readonly requiredSecrets = [] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@onenomad/cortex-pipeline-doc"] as const;

  private auth!: GoogleAuthClient;
  private cfg!: GoogleCalendarConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const token = await readGoogleToken();
    this.auth = new GoogleAuthClient({ token });
    if (!this.auth.hasAllScopes(SCOPES)) {
      this.ctx.logger.warn("google-calendar.scope_missing", {
        required: SCOPES,
        have: this.auth.scopes,
      });
    }
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    const first = this.cfg.calendars[0] ?? "primary";
    const params = new URLSearchParams({ maxResults: "1" });
    await this.auth.authorizedFetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(first)}/events?${params.toString()}`,
    );
    return { calendarsConfigured: this.cfg.calendars.length };
  }

  async *fetch(since?: Date): AsyncIterable<RawSourceItem> {
    const now = Date.now();
    const timeMin = since
      ? since.toISOString()
      : new Date(now - this.cfg.lookBackDays * 86_400_000).toISOString();
    const timeMax = new Date(
      now + this.cfg.lookAheadDays * 86_400_000,
    ).toISOString();

    for (const calendarId of this.cfg.calendars) {
      let pageToken: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const params = new URLSearchParams({
          singleEvents: "true",
          showDeleted: "false",
          orderBy: "updated",
          timeMin,
          timeMax,
          maxResults: String(this.cfg.pageSize),
        });
        if (pageToken) params.set("pageToken", pageToken);
        const data = await this.auth.authorizedFetch<EventsResponse>(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        );
        for (const event of data.items ?? []) {
          if (event.status === "cancelled") continue;
          yield {
            sourceId: `calendar:event:${calendarId}:${event.id}`,
            raw: { event, calendarId } satisfies RawCalendarItem,
          };
        }
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
    }
    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const item = raw.raw as RawCalendarItem;
    const { event, calendarId } = item;
    const startIso = event.start?.dateTime ?? event.start?.date ?? event.created;
    const endIso = event.end?.dateTime ?? event.end?.date ?? event.updated;
    const title = event.summary?.trim() || "(no title)";
    const parts: string[] = [];

    parts.push(`# ${title}`);
    const meta: string[] = [`When: ${startIso}${endIso ? ` → ${endIso}` : ""}`];
    if (event.location) meta.push(`Where: ${event.location}`);
    if (event.organizer?.displayName || event.organizer?.email) {
      meta.push(
        `Organizer: ${event.organizer.displayName ?? event.organizer.email}`,
      );
    }
    parts.push(meta.join(" · "));

    const attendees = (event.attendees ?? []).filter(
      (a) => a.email && !a.optional,
    );
    if (attendees.length > 0) {
      parts.push(
        "## Attendees\n\n" +
          attendees
            .map((a) => `- ${a.displayName ?? a.email} <${a.email}>`)
            .join("\n"),
      );
    }

    const meetingLink = event.conferenceData?.entryPoints?.find(
      (e) => e.entryPointType === "video",
    )?.uri;
    if (meetingLink) parts.push(`[Join meeting](${meetingLink})`);

    if (event.description) {
      parts.push(`## Description\n\n${stripHtml(event.description).trim()}`);
    }

    const authors = attendees
      .map((a) => a.email)
      .filter((e): e is string => typeof e === "string");

    return {
      sourceId: raw.sourceId,
      sourceType: "calendar",
      sourceUrl: event.htmlLink,
      title,
      content: parts.join("\n\n"),
      contentType: "event",
      createdAt: new Date(event.created),
      updatedAt: new Date(event.updated),
      authors,
      rawMetadata: {
        calendarId,
        eventId: event.id,
        start: startIso,
        end: endIso,
        recurringEventId: event.recurringEventId,
      },
    };
  }

  async classify(
    item: NormalizedItem,
    cctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const calendarId = item.rawMetadata.calendarId as string | undefined;
    const mapped = calendarId ? this.cfg.calendarToProject[calendarId] : undefined;
    if (mapped) {
      return {
        ...item,
        projects: [mapped],
        confidence: 0.9,
        classificationMethod: "rule",
      };
    }
    return { ...item, ...(await this.fallbackClassify(item, cctx, this.cfg.defaultProject)) };
  }

  /**
   * Surface every calendar the authed user can read as a project
   * candidate. The wizard layer decides which to keep and writes
   * `google_calendar_id` into the resulting projects.yaml entry.
   *
   * Skips calendars with `hidden` or `deleted` set, and system calendars
   * Google provides (birthdays, holidays, etc.) — those aren't projects.
   */
  async discoverProjects(): Promise<ProjectCandidate[]> {
    interface CalendarListEntry {
      id: string;
      summary?: string;
      summaryOverride?: string;
      description?: string;
      accessRole?: string;
      primary?: boolean;
      hidden?: boolean;
      deleted?: boolean;
    }
    interface CalendarListResponse {
      items?: CalendarListEntry[];
      nextPageToken?: string;
    }

    const candidates: ProjectCandidate[] = [];
    let pageToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams({ maxResults: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await this.auth.authorizedFetch<CalendarListResponse>(
        `https://www.googleapis.com/calendar/v3/users/me/calendarList?${params.toString()}`,
      );
      for (const entry of data.items ?? []) {
        if (entry.hidden || entry.deleted) continue;
        // Skip system-provided read-only calendars (holidays, birthdays,
        // US Holidays, etc.). They surface as accessRole "reader" with an
        // `@group.v.calendar.google.com` id suffix.
        if (entry.id.endsWith("@group.v.calendar.google.com")) continue;
        const name = (entry.summaryOverride ?? entry.summary ?? "").trim();
        if (!name) continue;
        candidates.push({
          slug: slugify(name),
          name,
          ...(entry.description ? { description: entry.description } : {}),
          sourceHints: { google_calendar_id: entry.id },
        });
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return candidates;
  }
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "calendar";
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export const createAdapter: AdapterFactory = () => new GoogleCalendarAdapter();
