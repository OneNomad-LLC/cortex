import { describe, expect, it } from "vitest";
import { blocksToMarkdown, type NotionBlock } from "../src/blocks.js";

describe("blocksToMarkdown", () => {
  it("handles headings, paragraphs, lists, and inline marks", () => {
    const blocks: NotionBlock[] = [
      {
        id: "1",
        type: "heading_2",
        heading_2: { rich_text: [{ plain_text: "Plan" }] },
      },
      {
        id: "2",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { plain_text: "Ship " },
            { plain_text: "Alpha", annotations: { bold: true } },
            { plain_text: " by Friday." },
          ],
        },
      },
      {
        id: "3",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "First" }] },
      },
      {
        id: "4",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "Second" }] },
      },
    ];

    const md = blocksToMarkdown(blocks);
    expect(md).toContain("## Plan");
    expect(md).toContain("Ship **Alpha** by Friday.");
    expect(md).toContain("- First");
    expect(md).toContain("- Second");
  });

  it("handles todo with checked state", () => {
    const blocks: NotionBlock[] = [
      {
        id: "1",
        type: "to_do",
        to_do: { rich_text: [{ plain_text: "Done item" }], checked: true },
      },
      {
        id: "2",
        type: "to_do",
        to_do: { rich_text: [{ plain_text: "Open item" }], checked: false },
      },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain("- [x] Done item");
    expect(md).toContain("- [ ] Open item");
  });

  it("renders code blocks with language", () => {
    const blocks: NotionBlock[] = [
      {
        id: "1",
        type: "code",
        code: {
          language: "python",
          rich_text: [{ plain_text: "print('hi')" }],
        },
      },
    ];
    expect(blocksToMarkdown(blocks)).toContain("```python\nprint('hi')\n```");
  });

  it("renders links and callouts", () => {
    const blocks: NotionBlock[] = [
      {
        id: "1",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { plain_text: "see", href: "https://x.example" },
          ],
        },
      },
      {
        id: "2",
        type: "callout",
        callout: {
          icon: { emoji: "⚠️" },
          rich_text: [{ plain_text: "Important note." }],
        },
      },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain("[see](https://x.example)");
    expect(md).toContain("> ⚠️ Important note.");
  });
});
