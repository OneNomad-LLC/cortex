import { describe, expect, it } from "vitest";
import {
  parseNotifyArgs,
  flavorToTemplate,
  buildTriggerId,
  buildPlaceholderVars,
} from "../src/cli/notify-args.js";

describe("parseNotifyArgs", () => {
  it("requires a flavor", () => {
    expect(parseNotifyArgs([])).toEqual(
      expect.objectContaining({ error: expect.stringContaining("flavor required") }),
    );
  });

  it("rejects unknown flavors", () => {
    expect(parseNotifyArgs(["bogus"])).toEqual(
      expect.objectContaining({ error: expect.stringContaining("unknown flavor") }),
    );
  });

  it("parses morning + dry-run + custom channel", () => {
    expect(parseNotifyArgs(["morning", "--dry-run", "--channel=@matt"])).toEqual({
      flavor: "morning",
      dryRun: true,
      channel: "@matt",
    });
  });

  it("defaults channel to @self when not specified", () => {
    const r = parseNotifyArgs(["eod"]);
    expect(r).toEqual({ flavor: "eod", dryRun: false, channel: "@self" });
  });

  it("rejects unknown flags", () => {
    expect(parseNotifyArgs(["morning", "--bogus"])).toEqual(
      expect.objectContaining({ error: expect.stringContaining("unknown flag") }),
    );
  });
});

describe("flavorToTemplate", () => {
  it("maps each flavor to its template", () => {
    expect(flavorToTemplate("morning")).toBe("morning-brief");
    expect(flavorToTemplate("pre-meeting")).toBe("pre-meeting-brief");
    expect(flavorToTemplate("eod")).toBe("eod-capture");
  });
});

describe("buildTriggerId", () => {
  it("morning + eod use day-precision keys", () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    expect(buildTriggerId("morning", now)).toBe("morning-brief:2026-04-27");
    expect(buildTriggerId("eod", now)).toBe("eod-capture:2026-04-27");
  });

  it("pre-meeting manual triggers use minute-precision keys", () => {
    const now = new Date("2026-04-27T12:34:00.000Z");
    expect(buildTriggerId("pre-meeting", now)).toBe(
      "pre-meeting-manual:2026-04-27T12:34",
    );
  });
});

describe("buildPlaceholderVars", () => {
  it("morning includes the date + falsy flags so empty branches collapse", () => {
    const vars = buildPlaceholderVars("morning", new Date("2026-04-27T12:00:00.000Z"));
    expect(vars.date).toBe("2026-04-27");
    expect(vars.meetings).toBe(false);
    expect(vars.priorities).toBe(false);
    expect(vars.dashboard_url).toMatch(/localhost:3030/);
  });

  it("pre-meeting includes minutes_until + a placeholder event title", () => {
    const vars = buildPlaceholderVars("pre-meeting", new Date());
    expect(vars.event_title).toBe("Sample meeting");
    expect(vars.minutes_until).toBe(30);
  });

  it("eod always renders the clean-slate branch when counts are 0", () => {
    const vars = buildPlaceholderVars("eod", new Date());
    expect(vars.touched_count).toBe(0);
    expect(vars.open_count).toBe(0);
  });
});
