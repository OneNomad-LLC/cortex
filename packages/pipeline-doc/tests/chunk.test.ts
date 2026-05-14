import { describe, expect, it } from "vitest";
import { chunkByHeading } from "../src/chunk.js";

describe("chunkByHeading", () => {
  it("splits on H1 and H2 and preserves path", () => {
    const md = [
      "# Alpha",
      "alpha intro",
      "",
      "## Alpha One",
      "alpha one body",
      "",
      "## Alpha Two",
      "alpha two body",
      "",
      "# Beta",
      "beta body",
    ].join("\n");
    const chunks = chunkByHeading(md);
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ["Alpha"],
      ["Alpha", "Alpha One"],
      ["Alpha", "Alpha Two"],
      ["Beta"],
    ]);
    expect(chunks[0]?.content).toBe("alpha intro");
    expect(chunks[2]?.content).toBe("alpha two body");
    expect(chunks[3]?.content).toBe("beta body");
  });

  it("captures preamble with empty heading path", () => {
    const md = ["some intro", "", "# First Heading", "body"].join("\n");
    const chunks = chunkByHeading(md);
    expect(chunks[0]?.headingPath).toEqual([]);
    expect(chunks[0]?.content).toBe("some intro");
    expect(chunks[1]?.headingPath).toEqual(["First Heading"]);
  });

  it("ignores # inside fenced code blocks", () => {
    const md = [
      "# Real",
      "body",
      "",
      "```",
      "# not a heading",
      "```",
      "",
      "more body",
    ].join("\n");
    const chunks = chunkByHeading(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toEqual(["Real"]);
    expect(chunks[0]?.content).toContain("# not a heading");
    expect(chunks[0]?.content).toContain("more body");
  });
});
