import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses scalar keys and quoted strings", () => {
    const { metadata, body } = parseFrontmatter(
      ['---', 'title: Onboarding', 'project: "engineering"', 'tags: [a, b]', '---', '', 'Body goes here.', ''].join("\n"),
    );
    expect(metadata.title).toBe("Onboarding");
    expect(metadata.project).toBe("engineering");
    expect(metadata.tags).toEqual(["a", "b"]);
    expect(body.trim()).toBe("Body goes here.");
  });

  it("handles block-style arrays", () => {
    const { metadata } = parseFrontmatter(
      ['---', 'tags:', '  - one', '  - "two"', '---', ''].join("\n"),
    );
    expect(metadata.tags).toEqual(["one", "two"]);
  });

  it("returns the whole source as body when there is no frontmatter", () => {
    const { metadata, body } = parseFrontmatter("Just a note.");
    expect(metadata).toEqual({});
    expect(body).toBe("Just a note.");
  });

  it("never throws on malformed frontmatter", () => {
    const { metadata, body } = parseFrontmatter(
      '---\nnot: "unclosed\n\n# Heading\n',
    );
    // Malformed means the closing --- is never found — we bail on
    // frontmatter entirely and return the whole source as body.
    expect(metadata).toEqual({});
    expect(body).toContain("# Heading");
  });
});
