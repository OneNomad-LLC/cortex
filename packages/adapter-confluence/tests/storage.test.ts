import { describe, expect, it } from "vitest";
import { storageToMarkdown } from "../src/storage.js";

describe("storageToMarkdown", () => {
  it("maps headings, paragraphs, lists, and inline emphasis to markdown", () => {
    const storage =
      "<p>Intro.</p><h1>One</h1><p>First para.</p><ul><li>A</li><li><strong>B</strong></li></ul><h2>Two</h2><p>Link: <a href=\"https://x.example\">x</a></p>";
    const md = storageToMarkdown(storage);
    expect(md).toContain("Intro.");
    expect(md).toContain("# One");
    expect(md).toContain("First para.");
    expect(md).toContain("- A");
    expect(md).toContain("- **B**");
    expect(md).toContain("## Two");
    expect(md).toContain("[x](https://x.example)");
  });

  it("decodes entities and collapses whitespace", () => {
    const md = storageToMarkdown(
      "<p>foo &amp; bar &lt;baz&gt;</p><p>&nbsp;</p><p>next</p>",
    );
    expect(md).toContain("foo & bar <baz>");
    expect(md).not.toMatch(/\n{3,}/);
  });

  it("preserves code macro plain-text body as a fenced block", () => {
    const storage =
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[npm install]]></ac:plain-text-body></ac:structured-macro>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("```");
    expect(md).toContain("npm install");
  });
});
