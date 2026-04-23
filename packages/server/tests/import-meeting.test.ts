import { describe, expect, it } from "vitest";
import { normalizeTranscript } from "../src/cli/import-meeting.js";

describe("normalizeTranscript", () => {
  it("strips VTT headers, cue ids, and timecodes", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE This is a note block",
      "",
      "1",
      "00:00:00.000 --> 00:00:03.000",
      "Hello everyone, thanks for joining.",
      "",
      "2",
      "00:00:03.500 --> 00:00:07.000",
      "Today we're talking about the rollout.",
      "",
    ].join("\n");
    const out = normalizeTranscript(vtt, ".vtt");
    expect(out).not.toContain("WEBVTT");
    expect(out).not.toContain("-->");
    expect(out).not.toContain("NOTE");
    expect(out).toContain("Hello everyone");
    expect(out).toContain("rollout");
  });

  it("strips SRT sequence numbers and timecodes", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:03,000",
      "Line one.",
      "",
      "2",
      "00:00:03,500 --> 00:00:07,000",
      "Line two with <i>markup</i>.",
      "",
    ].join("\n");
    const out = normalizeTranscript(srt, ".srt");
    expect(out).not.toMatch(/^\d+$/m);
    expect(out).not.toContain("-->");
    expect(out).not.toContain("<i>");
    expect(out).toContain("Line one.");
    expect(out).toContain("Line two with markup.");
  });

  it("strips inline VTT speaker tags", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "<v Matt>Hey team, quick update.</v>",
      "",
    ].join("\n");
    const out = normalizeTranscript(vtt, ".vtt");
    expect(out).toContain("Hey team, quick update.");
    expect(out).not.toContain("<v");
  });

  it("passes markdown through unchanged", () => {
    const md = "# Kickoff\n\nMatt: We're shipping Monday.\nAlex: Agreed.\n";
    expect(normalizeTranscript(md, ".md")).toBe(md);
  });
});
