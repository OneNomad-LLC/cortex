import { describe, expect, it } from "vitest";
import { stripHtml } from "../src/mcp/tools/ingest-url.js";

describe("ingest_url: stripHtml", () => {
  it("extracts <title> separately from body text", () => {
    const { text, parsedTitle } = stripHtml(
      `<html><head><title>Hello World</title></head><body><p>Body text</p></body></html>`,
    );
    expect(parsedTitle).toBe("Hello World");
    expect(text).toBe("Body text");
  });

  it("normalizes whitespace inside the parsed title", () => {
    const { parsedTitle } = stripHtml(
      `<title>\n  Multi\n  Line\n  Title  </title>`,
    );
    expect(parsedTitle).toBe("Multi Line Title");
  });

  it("drops <script>, <style>, <noscript>, <svg>, <head> blocks entirely", () => {
    const html = `
      <html>
        <head><title>T</title><style>body{color:red}</style></head>
        <body>
          <script>alert("x")</script>
          <noscript>no js</noscript>
          <svg><circle cx="0" cy="0" r="1"/></svg>
          <p>Real content here</p>
        </body>
      </html>
    `;
    const { text } = stripHtml(html);
    expect(text).toContain("Real content here");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("no js");
    expect(text).not.toContain("circle");
  });

  it("preserves paragraph breaks via block-tag→newline normalization", () => {
    const html = `<p>First paragraph</p><p>Second paragraph</p><p>Third paragraph</p>`;
    const { text } = stripHtml(html);
    // Paragraphs should be separated by newlines (not glued together).
    const paragraphs = text.split(/\n+/).filter((s) => s.trim().length > 0);
    expect(paragraphs).toEqual(["First paragraph", "Second paragraph", "Third paragraph"]);
  });

  it("decodes the common HTML entities used in plain prose", () => {
    const html = `<p>5 &amp; 6 &lt; 7 &gt; 4 &quot;quoted&quot; &#39;single&#39; &nbsp;space&apos;s</p>`;
    const { text } = stripHtml(html);
    // Whitespace collapse is part of the contract — adjacent spaces (including
    // a decoded &nbsp; next to a literal space) collapse to a single space.
    expect(text).toBe(`5 & 6 < 7 > 4 "quoted" 'single' space's`);
  });

  it("strips HTML comments", () => {
    const { text } = stripHtml(`<p>Visible</p><!-- secret --><p>Also visible</p>`);
    expect(text).toContain("Visible");
    expect(text).toContain("Also visible");
    expect(text).not.toContain("secret");
  });

  it("collapses runs of three or more newlines down to two (paragraph max)", () => {
    const { text } = stripHtml(`<p>A</p><p>B</p>\n\n\n\n\n<p>C</p>`);
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("handles missing <title> gracefully (returns empty title)", () => {
    const { parsedTitle } = stripHtml(`<html><body><p>Hi</p></body></html>`);
    expect(parsedTitle).toBe("");
  });

  it("handles unclosed tags without crashing", () => {
    expect(() => stripHtml(`<p>Unclosed`)).not.toThrow();
  });
});
