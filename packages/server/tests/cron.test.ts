import { describe, expect, it } from "vitest";
import { nextFireAfter, parseCron } from "../src/cron.js";

describe("parseCron", () => {
  it("accepts every-N-minutes expressions", () => {
    const s = parseCron("*/15 * * * *");
    expect(s.minute(0)).toBe(true);
    expect(s.minute(15)).toBe(true);
    expect(s.minute(14)).toBe(false);
    expect(s.minute(30)).toBe(true);
    expect(s.minute(45)).toBe(true);
  });

  it("accepts exact values", () => {
    const s = parseCron("0 3 * * *");
    expect(s.minute(0)).toBe(true);
    expect(s.minute(1)).toBe(false);
    expect(s.hour(3)).toBe(true);
    expect(s.hour(4)).toBe(false);
  });

  it("accepts comma lists and ranges", () => {
    const s = parseCron("0,30 9-17 * * *");
    expect(s.minute(0)).toBe(true);
    expect(s.minute(15)).toBe(false);
    expect(s.minute(30)).toBe(true);
    expect(s.hour(8)).toBe(false);
    expect(s.hour(9)).toBe(true);
    expect(s.hour(17)).toBe(true);
    expect(s.hour(18)).toBe(false);
  });

  it("accepts */6 hours", () => {
    const s = parseCron("0 */6 * * *");
    expect(s.hour(0)).toBe(true);
    expect(s.hour(6)).toBe(true);
    expect(s.hour(12)).toBe(true);
    expect(s.hour(18)).toBe(true);
    expect(s.hour(7)).toBe(false);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/invalid field/);
  });
});

describe("nextFireAfter", () => {
  it("lands on the next */15 minute boundary", () => {
    const schedule = parseCron("*/15 * * * *");
    const from = new Date("2026-04-22T10:07:30.000Z");
    const next = nextFireAfter(schedule, from);
    expect(next.toISOString()).toBe("2026-04-22T10:15:00.000Z");
  });

  it("rolls forward to the next hour for hourly schedules", () => {
    const schedule = parseCron("0 * * * *");
    const from = new Date("2026-04-22T10:00:30.000Z");
    const next = nextFireAfter(schedule, from);
    expect(next.toISOString()).toBe("2026-04-22T11:00:00.000Z");
  });

  it("lands on the next configured hour for daily schedules", () => {
    // Cron evaluates in local time (standard cron convention). Construct
    // `from` via local-time components so the assertion works regardless
    // of the runner's timezone.
    const schedule = parseCron("0 3 * * *");
    const from = new Date(2026, 3, 22, 4, 0, 0); // 4am local
    const next = nextFireAfter(schedule, from);
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  it("advances strictly — never returns `from`", () => {
    const schedule = parseCron("*/5 * * * *");
    const from = new Date("2026-04-22T10:10:00.000Z");
    const next = nextFireAfter(schedule, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });
});
