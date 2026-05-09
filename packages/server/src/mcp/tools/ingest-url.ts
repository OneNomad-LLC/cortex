import { z } from "zod";
import { ingestContent } from "./ingest-content.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  url: z.string().url(),
  project: z.string().min(1),
  /**
   * Page title override (single-page mode only — when crawling, each
   * page uses its own <title>). Falls back to the parsed <title> or
   * the URL itself.
   */
  title: z.string().default(""),
  tags: z.array(z.string()).default([]),
  /** Hard cap on response body PER PAGE. Default 2 MiB. */
  maxBytes: z.number().int().positive().default(2 * 1024 * 1024),
  /** Per-fetch timeout in milliseconds. Default 30s. */
  timeoutMs: z.number().int().positive().default(30_000),
  /**
   * Crawl depth. 0 (default) = ingest just `url`. 1 = also follow
   * every same-host link found on the seed page. 2 = follow links on
   * the pages found at depth 1, etc. Capped at 5 to keep a runaway
   * crawl bounded. Combined with `maxPages` (the absolute hard cap)
   * this gives the caller two orthogonal levers.
   */
  crawlDepth: z.number().int().min(0).max(5).default(0),
  /**
   * Absolute hard ceiling on pages fetched per call. Includes the seed
   * page. Default 50 — enough for a typical docs section, small enough
   * that a misconfigured crawl won't blow the chunk budget. Set lower
   * for "test the crawl" runs; higher for full sites (consider an
   * async job runner before going past a few hundred).
   */
  maxPages: z.number().int().positive().max(500).default(50),
  /**
   * When true (default), crawls only URLs whose path starts with the
   * seed URL's directory. Example: seed "https://docs.example.com/v2/api/intro"
   * → only crawls "/v2/api/...". Stops the crawl from wandering into
   * "/blog/" or the marketing site root. Set false to crawl any
   * same-host URL.
   */
  samePathPrefixOnly: z.boolean().default(true),
});

interface PageResult {
  url: string;
  title: string;
  bytes: number;
  ingested: number;
  /** Depth at which this page was discovered (0 = seed). */
  depth: number;
}

interface Output {
  /** True for backwards compat with the single-page caller — sums chunks across all pages. */
  ingested: number;
  project: string;
  /** First page's URL — kept as `url` for back-compat with single-page callers. */
  url: string;
  /** First page's title — same back-compat reason. */
  title: string;
  /** Total bytes fetched across every page. */
  bytes: number;
  /** Per-page summary. Capped at 50 entries to keep payloads bounded. */
  pages: PageResult[];
  /** Number of pages successfully ingested. */
  pagesIngested: number;
  /** Number of pages skipped (off-host, off-prefix, dedup, parse failure). */
  pagesSkipped: number;
  /** True when the crawl stopped because maxPages was hit before the queue drained. */
  truncated: boolean;
  /** Per-page errors. Capped at 50 entries. */
  errors: Array<{ source_id: string; error: string }>;
}

/**
 * Fetch a URL (and optionally its linked pages on the same host),
 * extract readable text, ingest into Cortex.
 *
 * Default behavior (crawlDepth=0): single-page mode — same as the
 * Phase 2 implementation. Set crawlDepth >= 1 to follow links.
 *
 * The crawler is BFS, deduplicated by absolute URL, scoped to the
 * seed URL's host, and (when `samePathPrefixOnly` is true, the
 * default) restricted to URLs whose path starts with the seed's
 * directory. `maxPages` is the absolute ceiling, applied across the
 * whole crawl regardless of depth.
 *
 * NOT suitable for SPAs — no JavaScript rendering. Use ingest_content
 * with the rendered text for those.
 */
export const ingestUrl: McpTool<typeof inputSchema, Output> = {
  name: "ingest_url",
  description:
    "Fetch a URL and ingest its text into Cortex. Strips HTML to text. " +
    "Set `crawlDepth` >= 1 to follow same-host links (BFS, dedup, capped " +
    "at maxPages). `samePathPrefixOnly` (default true) restricts the " +
    "crawl to the seed URL's path prefix so docs ingestion doesn't wander " +
    "into the marketing site or blog. Best for documentation sections, " +
    "RFC indexes, plain article archives.",
  inputSchema,

  async handler(input, ctx) {
    const seedUrl = normalizeUrl(input.url);
    const seedParsed = new URL(seedUrl);
    const pathPrefix = input.samePathPrefixOnly
      ? deriveDirectoryPrefix(seedParsed.pathname)
      : "/";

    const visited = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: seedUrl, depth: 0 }];
    const pages: PageResult[] = [];
    const errors: Array<{ source_id: string; error: string }> = [];
    let totalBytes = 0;
    let totalIngested = 0;
    let pagesSkipped = 0;
    let firstSeedTitle: string | null = null;
    let truncated = false;

    while (queue.length > 0) {
      const { url, depth } = queue.shift()!;
      if (visited.has(url)) {
        pagesSkipped += 1;
        continue;
      }
      visited.add(url);

      if (pages.length + 1 > input.maxPages) {
        truncated = true;
        break;
      }

      let pageHtml: string;
      let pageBytes: number;
      try {
        const r = await fetchPage(url, input);
        pageHtml = r.html;
        pageBytes = r.bytes;
      } catch (err) {
        if (errors.length < 50) {
          errors.push({ source_id: url, error: (err as Error).message });
        }
        pagesSkipped += 1;
        continue;
      }

      const { text, parsedTitle } = stripHtml(pageHtml);
      if (text.trim().length === 0) {
        if (errors.length < 50) {
          errors.push({ source_id: url, error: "extracted text was empty" });
        }
        pagesSkipped += 1;
        continue;
      }

      // Single-page mode preserves the user-supplied title override.
      // Crawl mode uses each page's own <title>.
      const finalTitle = (input.crawlDepth === 0 && input.title)
        ? input.title
        : (parsedTitle || url);

      try {
        const inner = await ingestContent.handler(
          {
            content: text,
            project: input.project,
            type: "doc",
            sourceId: url,
            title: finalTitle,
            sourceUrl: url,
            source: "manual",
            authors: [],
            tags: input.tags,
          },
          ctx,
        );
        const ingested = inner.ingested ?? 0;
        totalIngested += ingested;
        totalBytes += pageBytes;
        pages.push({
          url,
          title: finalTitle,
          bytes: pageBytes,
          ingested,
          depth,
        });
        if (firstSeedTitle === null) firstSeedTitle = finalTitle;
        if (Array.isArray(inner.errors) && inner.errors.length > 0 && errors.length < 50) {
          errors.push(...inner.errors.slice(0, 50 - errors.length));
        }
      } catch (err) {
        if (errors.length < 50) {
          errors.push({ source_id: url, error: (err as Error).message });
        }
        pagesSkipped += 1;
        continue;
      }

      // Discover links for the next BFS level. Skip when we're at the
      // configured depth already.
      if (depth < input.crawlDepth) {
        const links = extractSameHostLinks(pageHtml, url, seedParsed.host, pathPrefix);
        for (const link of links) {
          if (!visited.has(link)) {
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
    }

    return {
      ingested: totalIngested,
      project: input.project,
      url: seedUrl,
      title: firstSeedTitle ?? input.title ?? seedUrl,
      bytes: totalBytes,
      // Cap the per-page array at 50 entries — typical chunked ingest
      // returns a manageable size, but a 500-page crawl would otherwise
      // blow the response payload.
      pages: pages.slice(0, 50),
      pagesIngested: pages.length,
      pagesSkipped,
      truncated,
      errors,
    };
  },
};

interface FetchOptions {
  maxBytes: number;
  timeoutMs: number;
}

async function fetchPage(url: string, opts: FetchOptions): Promise<{ html: string; bytes: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Cortex-Knowledge-Engine/0.3",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    const bytes = buf.byteLength;
    if (bytes > opts.maxBytes) {
      throw new Error(`response ${bytes} bytes exceeds maxBytes=${opts.maxBytes}`);
    }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return { html, bytes };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trim trailing slash + drop fragment + lowercase the host for stable
 * dedup. Query strings are preserved (they often differentiate
 * legitimately-distinct content like ?lang=en vs ?lang=ja).
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.host = u.host.toLowerCase();
    // Strip a single trailing "/" from non-root paths so /foo and
    // /foo/ collapse. Roots ("/") stay as-is.
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Compute the directory portion of a path. Used for the
 * `samePathPrefixOnly` filter so a seed at /docs/v2/api/intro
 * crawls only /docs/v2/api/*, not the whole site.
 *
 * Path "/docs/v2/api/intro"      → "/docs/v2/api/"
 * Path "/docs/v2/api/intro.html" → "/docs/v2/api/"
 * Path "/docs/v2/api/"           → "/docs/v2/api/"
 * Path "/"                       → "/"
 */
export function deriveDirectoryPrefix(pathname: string): string {
  if (pathname === "/" || pathname === "") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return pathname.slice(0, lastSlash + 1);
}

/**
 * Pull every <a href="..."> out of the HTML, resolve it against the
 * page URL, then filter to:
 *   - same host (case-insensitive)
 *   - http/https scheme only
 *   - path starts with `pathPrefix`
 *   - not a fragment-only link to the same page
 * Returns deduplicated, normalized URLs.
 */
export function extractSameHostLinks(
  html: string,
  pageUrl: string,
  expectedHost: string,
  pathPrefix: string,
): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const href = match[2]?.trim();
    if (!href) continue;
    if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    if (abs.host.toLowerCase() !== expectedHost.toLowerCase()) continue;
    if (!abs.pathname.startsWith(pathPrefix)) continue;
    out.add(normalizeUrl(abs.toString()));
  }
  return Array.from(out);
}

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
