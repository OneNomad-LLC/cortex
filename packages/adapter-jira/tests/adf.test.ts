import { describe, expect, it } from "vitest";
import { adfToMarkdown, type AdfNode } from "../src/adf.js";

describe("adfToMarkdown", () => {
  it("renders paragraphs, headings, and lists", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Plan" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ship " },
            { type: "text", text: "Alpha", marks: [{ type: "strong" }] },
            { type: "text", text: " v2." },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "One" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Two" }] },
              ],
            },
          ],
        },
      ],
    };
    const md = adfToMarkdown(doc);
    expect(md).toContain("## Plan");
    expect(md).toContain("Ship **Alpha** v2.");
    expect(md).toContain("- One");
    expect(md).toContain("- Two");
  });

  it("renders code blocks with language", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toContain("```typescript\nconst x = 1;\n```");
  });

  it("renders link marks on text", () => {
    const doc: AdfNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "see docs",
              marks: [{ type: "link", attrs: { href: "https://x.example" } }],
            },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toContain("[see docs](https://x.example)");
  });

  it("returns empty string for null input", () => {
    expect(adfToMarkdown(null)).toBe("");
  });
});
