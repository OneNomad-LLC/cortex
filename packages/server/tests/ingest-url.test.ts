import { describe, expect, it } from "vitest";
import {
  stripHtml,
  normalizeUrl,
  deriveDirectoryPrefix,
  extractSameHostLinks,
} from "../src/mcp/tools/ingest-url.js";

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

describe("ingest_url: normalizeUrl", () => {
  it("strips fragments", () => {
    expect(normalizeUrl("https://x.com/foo#bar")).toBe("https://x.com/foo");
  });

  it("lowercases the host but not the path", () => {
    expect(normalizeUrl("https://Foo.Example.COM/Bar/Baz")).toBe("https://foo.example.com/Bar/Baz");
  });

  it("strips a single trailing slash from non-root paths", () => {
    expect(normalizeUrl("https://x.com/foo/")).toBe("https://x.com/foo");
  });

  it("preserves the root slash", () => {
    expect(normalizeUrl("https://x.com/")).toBe("https://x.com/");
  });

  it("preserves query strings (they often differentiate content)", () => {
    expect(normalizeUrl("https://x.com/foo?lang=en")).toBe("https://x.com/foo?lang=en");
  });

  it("returns the input unchanged when URL is unparseable", () => {
    expect(normalizeUrl("::not a url::")).toBe("::not a url::");
  });
});

describe("ingest_url: deriveDirectoryPrefix", () => {
  it("returns the parent directory of a file path", () => {
    expect(deriveDirectoryPrefix("/docs/v2/api/intro")).toBe("/docs/v2/api/");
  });

  it("returns the same dir when path is already a directory", () => {
    expect(deriveDirectoryPrefix("/docs/v2/api/")).toBe("/docs/v2/api/");
  });

  it("returns root for top-level files", () => {
    expect(deriveDirectoryPrefix("/intro")).toBe("/");
  });

  it("returns root for empty / root path", () => {
    expect(deriveDirectoryPrefix("/")).toBe("/");
    expect(deriveDirectoryPrefix("")).toBe("/");
  });
});

describe("ingest_url: extractSameHostLinks", () => {
  const pageUrl = "https://docs.example.com/v2/api/intro";

  it("pulls absolute links and resolves relative ones against the page URL", () => {
    const html = `
      <a href="https://docs.example.com/v2/api/auth">auth</a>
      <a href="/v2/api/users">users</a>
      <a href="../guide/start">guide</a>
    `;
    const links = extractSameHostLinks(html, pageUrl, "docs.example.com", "/v2/api/");
    // /v2/api/auth, /v2/api/users — both pass. ../guide/start resolves
    // to /v2/guide/start which is OUTSIDE /v2/api/ prefix → filtered out.
    expect(links).toContain("https://docs.example.com/v2/api/auth");
    expect(links).toContain("https://docs.example.com/v2/api/users");
    expect(links).not.toContain("https://docs.example.com/v2/guide/start");
  });

  it("excludes off-host links", () => {
    const html = `
      <a href="https://docs.example.com/v2/api/auth">internal</a>
      <a href="https://blog.example.com/v2/api/auth">subdomain</a>
      <a href="https://other.com/v2/api/auth">external</a>
    `;
    const links = extractSameHostLinks(html, pageUrl, "docs.example.com", "/v2/api/");
    expect(links).toEqual(["https://docs.example.com/v2/api/auth"]);
  });

  it("excludes fragment-only / javascript: / mailto: / tel: links", () => {
    const html = `
      <a href="#section-2">jump</a>
      <a href="javascript:void(0)">js</a>
      <a href="mailto:hi@example.com">email</a>
      <a href="tel:+15551234">call</a>
    `;
    const links = extractSameHostLinks(html, pageUrl, "docs.example.com", "/v2/api/");
    expect(links).toEqual([]);
  });

  it("dedupes by normalized URL", () => {
    const html = `
      <a href="/v2/api/auth">a</a>
      <a href="/v2/api/auth#section">a-with-fragment</a>
      <a href="/v2/api/auth/">a-with-trailing-slash</a>
    `;
    const links = extractSameHostLinks(html, pageUrl, "docs.example.com", "/v2/api/");
    expect(links).toEqual(["https://docs.example.com/v2/api/auth"]);
  });

  it("respects a root-only prefix when the caller wants any same-host URL", () => {
    const html = `
      <a href="/v2/api/auth">api</a>
      <a href="/blog/post-1">blog</a>
      <a href="/about">about</a>
    `;
    const links = extractSameHostLinks(html, pageUrl, "docs.example.com", "/");
    expect(links).toContain("https://docs.example.com/v2/api/auth");
    expect(links).toContain("https://docs.example.com/blog/post-1");
    expect(links).toContain("https://docs.example.com/about");
  });

  it("ignores malformed href values gracefully", () => {
    const html = `<a href="">empty</a><a href="   ">whitespace</a><a>no href</a>`;
    expect(() => extractSameHostLinks(html, pageUrl, "docs.example.com", "/")).not.toThrow();
  });

  it("handles single-quoted href attributes", () => {
    const html = `<a href='/v2/api/single'>single-quoted</a>`;
    const links = extractSameHostLinks(html, pageUrl, "docs.example.com", "/v2/api/");
    expect(links).toEqual(["https://docs.example.com/v2/api/single"]);
  });
});
