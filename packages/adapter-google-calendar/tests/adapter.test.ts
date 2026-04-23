import { describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@onenomad/cortex-core";
import { GoogleCalendarAdapter } from "../src/adapter.js";

function baseCtx(cfg: Record<string, unknown>): AdapterContext {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    logger,
    config: cfg,
    secrets: {},
    signal: new AbortController().signal,
    engram: {
      ingest: vi.fn(async () => ({ id: "fake" })),
      healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    },
    taxonomy: {
      listProjects: () => [],
      findProjectBySlug: () => undefined,
      findProject: () => undefined,
      listPeople: () => [],
      findPersonBySlug: () => undefined,
      findPersonByEmail: () => undefined,
      findPerson: () => undefined,
    },
    llm: { raw: null, complete: vi.fn() },
  };
}

describe("GoogleCalendarAdapter transform/classify", () => {
  it("transforms an event into a doc-shaped NormalizedItem", async () => {
    const adapter = new GoogleCalendarAdapter();
    // init would load the token from disk — bypass for a pure transform test.
    (adapter as unknown as { cfg: unknown }).cfg = {
      calendars: ["primary"],
      lookAheadDays: 14,
      lookBackDays: 1,
      pageSize: 250,
      calendarToProject: { primary: "engineering" },
      defaultProject: "",
    };

    const raw = {
      event: {
        id: "evt-1",
        status: "confirmed",
        summary: "Alpha standup",
        description: "<p>Quick sync on <strong>v2</strong>.</p>",
        location: "Zoom",
        htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
        created: "2026-04-20T12:00:00.000Z",
        updated: "2026-04-22T09:00:00.000Z",
        start: { dateTime: "2026-04-22T15:00:00.000Z" },
        end: { dateTime: "2026-04-22T15:30:00.000Z" },
        organizer: { email: "alex@example.com", displayName: "Alex" },
        attendees: [
          { email: "alex@example.com", displayName: "Alex", optional: false },
          { email: "sarah@example.com", displayName: "Sarah", optional: false },
          { email: "bot@example.com", displayName: "Bot", optional: true },
        ],
        conferenceData: {
          entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/123" }],
        },
      },
      calendarId: "primary",
    };

    const normalized = await adapter.transform({
      sourceId: "calendar:event:primary:evt-1",
      raw,
    });

    expect(normalized.sourceType).toBe("calendar");
    expect(normalized.contentType).toBe("event");
    expect(normalized.title).toBe("Alpha standup");
    expect(normalized.content).toContain("# Alpha standup");
    expect(normalized.content).toContain("When: 2026-04-22T15:00:00.000Z");
    expect(normalized.content).toContain("## Attendees");
    expect(normalized.content).toContain("- Alex <alex@example.com>");
    expect(normalized.content).toContain("[Join meeting](https://zoom.us/j/123)");
    // stripHtml removes tags, so <strong>v2</strong> becomes plain "v2".
    expect(normalized.content).toContain("Quick sync on v2.");
    // Optional attendee excluded.
    expect(normalized.authors).toEqual(["alex@example.com", "sarah@example.com"]);
  });

  it("classifies via calendarToProject map", async () => {
    const adapter = new GoogleCalendarAdapter();
    (adapter as unknown as { cfg: unknown }).cfg = {
      calendars: ["primary"],
      lookAheadDays: 14,
      lookBackDays: 1,
      pageSize: 250,
      calendarToProject: { primary: "engineering" },
      defaultProject: "",
    };

    const classified = await adapter.classify(
      {
        sourceId: "x",
        sourceType: "calendar",
        sourceUrl: "https://x",
        title: "t",
        content: "c",
        contentType: "event",
        createdAt: new Date(),
        updatedAt: new Date(),
        authors: [],
        rawMetadata: { calendarId: "primary" },
      },
      {},
    );
    expect(classified.projects).toEqual(["engineering"]);
  });
});
