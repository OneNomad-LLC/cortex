import { describe, expect, it } from "vitest";
import { parseConversation, serializeConversation } from "../src/parse.js";

describe("parseConversation", () => {
  it("parses plain Speaker: text lines", () => {
    const msgs = parseConversation(
      ["Alex: hi team", "Sarah: hey", "Alex: quick update"].join("\n"),
    );
    expect(msgs).toEqual([
      { speaker: "Alex", text: "hi team" },
      { speaker: "Sarah", text: "hey" },
      { speaker: "Alex", text: "quick update" },
    ]);
  });

  it("parses timestamp-prefixed lines", () => {
    const msgs = parseConversation(
      "[2026-04-22T12:00:00Z] Alex: hi",
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.speaker).toBe("Alex");
    expect(msgs[0]?.timestampIso).toBe("2026-04-22T12:00:00Z");
  });

  it("appends continuation lines to the previous message", () => {
    const msgs = parseConversation(
      ["Alex: first line", "  second line", "  third line"].join("\n"),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toContain("first line");
    expect(msgs[0]?.text).toContain("second line");
    expect(msgs[0]?.text).toContain("third line");
  });

  it("serializes back to Speaker: text form", () => {
    const round = serializeConversation(
      parseConversation("Alex: hi\nSarah: bye"),
    );
    expect(round).toBe("Alex: hi\nSarah: bye");
  });
});
