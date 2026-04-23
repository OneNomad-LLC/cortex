import { GoogleAuthClient } from "@onenomad/cortex-google-auth";
import { describe, expect, it } from "vitest";
import { createTodayMeetingsWidget } from "../src/api/widgets/today-meetings.js";
import type { WidgetContext } from "../src/api/types.js";
import type { Logger } from "@onenomad/cortex-core";

function nullLogger(): Logger {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log;
}

function mockCtx(): WidgetContext {
  return {
    logger: nullLogger(),
    engram: {} as never,
    llmRouter: {} as never,
    taxonomy: {} as never,
  };
}

function stubAuth(
  fetchImpl: typeof fetch,
): () => Promise<GoogleAuthClient> {
  return async () =>
    new GoogleAuthClient({
      token: {
        client_id: "x",
        client_secret: "y",
        refresh_token: "z",
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        token_endpoint: "https://oauth2.googleapis.com/token",
      },
      fetchImpl,
    });
}

describe("today-meetings widget", () => {
  it("returns an informative note when no token is available", async () => {
    const widget = createTodayMeetingsWidget({
      resolveAuth: async () => {
        throw new Error("no token");
      },
    });
    const out = await widget.handler(new URLSearchParams(), mockCtx());
    expect(out.rows).toEqual([]);
    expect(out.note).toMatch(/google-login/i);
  });

  it("shapes calendar events into meeting rows sorted by start time", async () => {
    const now = new Date();
    const today = new Date(now);
    today.setHours(9, 0, 0, 0);
    const later = new Date(now);
    later.setHours(14, 30, 0, 0);

    const fetchImpl: typeof fetch = async (url, init) => {
      // First call: refresh token. Second: events.
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "stub-token",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/calendar.readonly",
            token_type: "Bearer",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      // Events endpoint.
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "evt2",
              status: "confirmed",
              summary: "Afternoon sync",
              htmlLink: "https://calendar.google.com/event?eid=2",
              start: { dateTime: later.toISOString() },
              end: {
                dateTime: new Date(later.getTime() + 30 * 60_000).toISOString(),
              },
              organizer: { displayName: "Alex" },
              attendees: [
                { email: "matt@example.com", responseStatus: "accepted" },
                { email: "alex@example.com", responseStatus: "accepted" },
              ],
              conferenceData: {
                entryPoints: [
                  {
                    entryPointType: "video",
                    uri: "https://meet.google.com/aaa-bbb-ccc",
                  },
                ],
              },
            },
            {
              id: "evt1",
              status: "confirmed",
              summary: "Morning standup",
              htmlLink: "https://calendar.google.com/event?eid=1",
              start: { dateTime: today.toISOString() },
              end: {
                dateTime: new Date(today.getTime() + 30 * 60_000).toISOString(),
              },
              attendees: [
                { email: "matt@example.com", responseStatus: "accepted" },
              ],
            },
            {
              id: "evt3",
              status: "cancelled",
              summary: "Cancelled event",
              start: { dateTime: later.toISOString() },
              end: { dateTime: later.toISOString() },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      void init;
    };

    const widget = createTodayMeetingsWidget({
      resolveAuth: stubAuth(fetchImpl),
    });
    const out = await widget.handler(
      new URLSearchParams({ calendars: "primary" }),
      mockCtx(),
    );

    expect(out.rows.length).toBe(2);
    expect(out.rows[0]!.title).toBe("Morning standup");
    expect(out.rows[1]!.title).toBe("Afternoon sync");
    expect(out.rows[1]!.meetingUrl).toBe("https://meet.google.com/aaa-bbb-ccc");
    expect(out.rows[1]!.attendees).toEqual([
      "matt@example.com",
      "alex@example.com",
    ]);
    expect(out.note).toBeUndefined();
  });

  it("supports multi-calendar via the calendars query param", async () => {
    const calledIds: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "stub",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/calendar.readonly",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const match = u.match(/\/calendars\/([^/]+)\/events/);
      if (match) calledIds.push(decodeURIComponent(match[1]!));
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const widget = createTodayMeetingsWidget({
      resolveAuth: stubAuth(fetchImpl),
    });
    await widget.handler(
      new URLSearchParams({ calendars: "primary,team@example.com" }),
      mockCtx(),
    );
    expect(calledIds).toEqual(["primary", "team@example.com"]);
  });
});
