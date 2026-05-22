import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown";

describe("renderMarkdown()", () => {
  it("renders headings, paragraphs and inline code", () => {
    const html = renderMarkdown(
      "# Title\n\nFirst paragraph with `code`.",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>First paragraph with <code>code</code>.</p>");
  });

  it("renders unordered lists", () => {
    const html = renderMarkdown("- one\n- two\n- three");
    expect(html).toContain(
      "<ul><li>one</li><li>two</li><li>three</li></ul>",
    );
  });

  it("renders ordered lists", () => {
    const html = renderMarkdown("1. step one\n2. step two");
    expect(html).toContain(
      "<ol><li>step one</li><li>step two</li></ol>",
    );
  });

  it("renders inline links with target=_blank", () => {
    const html = renderMarkdown("See [docs](https://example.com).");
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it("resolves reference-style links and strips the definition list", () => {
    const html = renderMarkdown(
      "Read the [device flow][device].\n\n[device]: https://docs.github.com/x",
    );
    expect(html).toContain(
      '<a href="https://docs.github.com/x" target="_blank" rel="noopener noreferrer">device flow</a>',
    );
    // The "[device]: …" line itself should not appear in the output.
    expect(html).not.toContain("[device]: https://docs.github.com/x");
  });

  it("renders bold and italic inline marks", () => {
    const html = renderMarkdown("**bold** and _italic_ together.");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("escapes raw HTML to prevent XSS", () => {
    const html = renderMarkdown("<script>alert('x')</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders fenced code blocks", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain('<pre data-lang="ts"><code>const x = 1;</code></pre>');
  });

  it("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
