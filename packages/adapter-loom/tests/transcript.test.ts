import { describe, expect, it } from "vitest";
import { transcriptToMarkdown } from "../src/transcript.js";

describe("transcriptToMarkdown", () => {
  it("folds consecutive segments by the same speaker", () => {
    const md = transcriptToMarkdown([
      { speaker: "Alex", text: "Hey team," },
      { speaker: "Alex", text: "quick update." },
      { speaker: "Sarah", text: "Go ahead." },
      { speaker: "Alex", text: "Ship is on track." },
    ]);
    expect(md).toBe(
      "Alex: Hey team, quick update.\nSarah: Go ahead.\nAlex: Ship is on track.",
    );
  });

  it("emits lines without prefix when speakers are missing", () => {
    const md = transcriptToMarkdown([
      { text: "Welcome to the recording." },
      { text: "Today we're covering..." },
    ]);
    expect(md).toBe("Welcome to the recording. Today we're covering...");
  });

  it("passes through a pre-formatted string", () => {
    expect(transcriptToMarkdown("Alex: hello.")).toBe("Alex: hello.");
  });

  it("returns empty string for null / empty inputs", () => {
    expect(transcriptToMarkdown(null)).toBe("");
    expect(transcriptToMarkdown(undefined)).toBe("");
    expect(transcriptToMarkdown([])).toBe("");
  });

  it("drops segments with empty text", () => {
    const md = transcriptToMarkdown([
      { speaker: "Alex", text: "" },
      { speaker: "Alex", text: "   " },
      { speaker: "Alex", text: "real content" },
    ]);
    expect(md).toBe("Alex: real content");
  });
});
