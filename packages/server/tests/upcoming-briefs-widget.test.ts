import { describe, expect, it } from "vitest";
import { upcomingBriefsWidget } from "../src/api/widgets/upcoming-briefs.js";
import type { WidgetContext } from "../src/api/types.js";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";
import type { Logger } from "@cortex/core";

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

function fakeEngram(rows: EngramMemory[]): EngramClient {
  return {
    async ingest() {
      return { id: "x" };
    },
    async search(args) {
      if (!args.type) return rows;
      return rows.filter((r) => {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
        return tags.includes(`type:${args.type}`) || r.type === args.type;
      });
    },
    async healthCheck() {
      return { healthy: true, message: "" };
    },
    async shutdown() {
      return;
    },
  };
}

function mockCtx(rows: EngramMemory[]): WidgetContext {
  return {
    logger: nullLogger(),
    engram: fakeEngram(rows),
    // llmRouter is non-optional on WidgetContext; upcoming-briefs'
    // generateBrief defaults to false so no LLM call fires in these tests.
    llmRouter: {} as never,
    taxonomy: {
      projects: [],
      people: [],
      findProject: () => undefined,
      findPerson: () => undefined,
    } as never,
  };
}

describe("upcoming-briefs widget", () => {
  it("returns events within the lookahead window", async () => {
    const soon = new Date(Date.now() + 30 * 60_000); // 30 min from now
    const later = new Date(Date.now() + 4 * 3_600_000); // 4 hours from now

    const out = await upcomingBriefsWidget.handler(
      new URLSearchParams({ hoursAhead: "8", limit: "5" }),
      mockCtx([
        {
          id: "e1",
          type: "event",
          content: "Weekly standup with the delivery team",
          metadata: {
            source_id: "calendar:event:primary:e1",
            source: "calendar",
            source_url: "https://calendar.google.com/event?eid=e1",
            title: "Delivery standup",
            project: "alpha",
            start: soon.toISOString(),
            date: soon.toISOString(),
            people: ["matt@example.com", "alex@example.com"],
          },
        },
        {
          id: "e2",
          type: "event",
          content: "Design review for new onboarding flow",
          metadata: {
            source_id: "calendar:event:primary:e2",
            source: "calendar",
            title: "Onboarding design review",
            project: "alpha",
            start: later.toISOString(),
            date: later.toISOString(),
          },
        },
      ]),
    );

    expect(out.events.length).toBe(2);
    expect(out.events[0]!.title).toBe("Delivery standup");
    expect(out.events[0]!.projectSlug).toBe("alpha");
    expect(out.events[0]!.attendees).toEqual([
      "matt@example.com",
      "alex@example.com",
    ]);
    // generateBrief defaults to false in the widget, so no LLM call, no brief.
    expect(out.events[0]!.brief).toBeUndefined();
  });

  it("filters out events outside the window", async () => {
    const tomorrow = new Date(Date.now() + 36 * 3_600_000);
    const out = await upcomingBriefsWidget.handler(
      new URLSearchParams({ hoursAhead: "8" }),
      mockCtx([
        {
          id: "e1",
          type: "event",
          content: "Far away",
          metadata: {
            source_id: "calendar:event:primary:e1",
            source: "calendar",
            title: "Far event",
            start: tomorrow.toISOString(),
            date: tomorrow.toISOString(),
          },
        },
      ]),
    );
    expect(out.events.length).toBe(0);
  });

  it("honors minutesThreshold for imminent-only briefs", async () => {
    const in10min = new Date(Date.now() + 10 * 60_000);
    const in2hours = new Date(Date.now() + 2 * 3_600_000);

    const out = await upcomingBriefsWidget.handler(
      new URLSearchParams({ hoursAhead: "24", minutesThreshold: "30" }),
      mockCtx([
        {
          id: "e-soon",
          type: "event",
          content: "Standup",
          metadata: {
            source_id: "calendar:event:primary:e-soon",
            title: "Standup",
            start: in10min.toISOString(),
            date: in10min.toISOString(),
          },
        },
        {
          id: "e-later",
          type: "event",
          content: "Later meeting",
          metadata: {
            source_id: "calendar:event:primary:e-later",
            title: "Later meeting",
            start: in2hours.toISOString(),
            date: in2hours.toISOString(),
          },
        },
      ]),
    );
    // Only the 10-minute-out event falls inside a 30-minute threshold.
    expect(out.events.length).toBe(1);
    expect(out.events[0]!.title).toBe("Standup");
  });
});
