import { z } from "zod";
import { ingestContent } from "./ingest-content.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  url: z.string().url(),
  project: z.string().min(1),
  /**
   * Page title override. When omitted, parsed from `<title>` of the
   * fetched HTML. Falls back to the URL itself.
   */
  title: z.string().default(""),
  tags: z.array(z.string()).default([]),
  /** Hard cap on response body. Default 2 MiB — protects against accidental large fetches. */
  maxBytes: z.number().int().positive().default(2 * 1024 * 1024),
  /** Per-fetch timeout in milliseconds. Default 30s. */
  timeoutMs: z.number().int().positive().default(30_000),
});

interface Output {
  ingested: number;
  sourceId: string;
  project: string;
  type: string;
  url: string;
  title: string;
  bytes: number;
  memories: Array<{
    content_preview: string;
    source_id: string;
    title?: string;
  }>;
  errors: Array<{
    source_id: string;
    error: string;
  }>;
}

/**
 * Fetch a URL, extract its readable text, and ingest it into Cortex.
 *
 * This is the simplest possible URL→KB path: GET the page, strip HTML
 * tags + script/style blocks, hand the text to the doc pipeline. Good
 * for documentation pages, blog posts, RFCs, plain articles.
 *
 * NOT suitable for SPAs that render content via JavaScript — those
 * need a headless browser, which Cortex doesn't ship. For a SPA, the
 * caller should use `cortex ingest_content` with the rendered text.
 *
 * Phase 2 scope: single-page only. Sitemap crawling lands in a follow-up.
 */
export const ingestUrl: McpTool<typeof inputSchema, Output> = {
  name: "ingest_url",
  description:
    "Fetch a URL and ingest its text content into Cortex. Strips HTML " +
    "tags, scripts, and styles to extract readable text. Single-page " +
    "only — no JavaScript rendering, no sitemap crawl. Best for docs, " +
    "blog posts, RFCs, plain articles. Provide a `project` to scope " +
    "the chunks; `title` is auto-extracted from <title> if omitted.",
  inputSchema,

  async handler(input, ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    let bytesFetched = 0;
    let html = "";
    try {
      const res = await fetch(input.url, {
        signal: controller.signal,
        headers: {
          // Generic UA — many sites refuse the default node-fetch UA. This
          // identifies as a Cortex bot so site owners can block it via
          // robots.txt if they want; no URL contact in the UA itself
          // (avoids the identifier-scan tripwire on the repo's own URL).
          "user-agent": "Cortex-Knowledge-Engine/0.3",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
      if (!res.ok) {
        throw new Error(`ingest_url: HTTP ${res.status} ${res.statusText} from ${input.url}`);
      }
      const buf = await res.arrayBuffer();
      bytesFetched = buf.byteLength;
      if (bytesFetched > input.maxBytes) {
        throw new Error(
          `ingest_url: ${input.url} returned ${bytesFetched} bytes, exceeds maxBytes=${input.maxBytes}`,
        );
      }
      html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    } finally {
      clearTimeout(timer);
    }

    const { text, parsedTitle } = stripHtml(html);
    if (text.trim().length === 0) {
      throw new Error(`ingest_url: extracted text from ${input.url} is empty`);
    }

    const finalTitle = input.title || parsedTitle || input.url;

    const inner = await ingestContent.handler(
      {
        content: text,
        project: input.project,
        type: "doc",
        sourceId: input.url,
        title: finalTitle,
        sourceUrl: input.url,
        // The URL itself is the source-of-truth provenance.
        source: "manual",
        authors: [],
        tags: input.tags,
      },
      ctx,
    );

    return {
      ...inner,
      url: input.url,
      title: finalTitle,
      bytes: bytesFetched,
    };
  },
};

/**
 * Cheap HTML→text extraction. Sufficient for the first cut.
 *
 * Strategy:
 *   1. Pull <title> out before stripping (so we keep page metadata).
 *   2. Drop `<script>`, `<style>`, `<noscript>`, `<svg>`, `<head>` blocks
 *      including their content.
 *   3. Drop HTML comments.
 *   4. Strip remaining tags but preserve their inner text.
 *   5. Decode the few HTML entities that show up most often in plain
 *      prose. Full entity decoding would need a parser; this is the
 *      90/10 cut for English/Latin-script content.
 *   6. Collapse whitespace runs to single spaces; preserve paragraph
 *      breaks (double-newline) where possible.
 */
export function stripHtml(html: string): { text: string; parsedTitle: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const parsedTitle = titleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";

  let text = html;
  // Remove blocks (with content) that never carry user-readable text.
  text = text.replace(/<head[\s\S]*?<\/head>/gi, "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  // Strip comments.
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // Normalize block-level tags into newlines so the prose isn't all glued
  // together once we strip remaining tags.
  text = text.replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)\s*>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags.
  text = text.replace(/<[^>]+>/g, "");
  // Decode the common entities. Full entity decoding requires a real
  // parser; covering &amp; / &lt; / &gt; / &quot; / &#39; / &nbsp; is
  // enough for the doc pipeline downstream — anything more exotic
  // round-trips as the literal entity sequence and won't hurt search.
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  // Collapse runs of whitespace; keep at most two newlines so paragraphs
  // stay distinct.
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return { text, parsedTitle };
}
