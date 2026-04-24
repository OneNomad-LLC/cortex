import type { ExtractorResult } from "../types";
import { hashUrl } from "./index";

const MAX_CHARS = 30_000;

/**
 * Fallback extractor when no site-specific one matches. Implements a
 * pint-sized Readability-style heuristic without pulling the
 * @mozilla/readability package (manifest size matters for MV3 review,
 * and a big chunk of that package targets cases we don't hit from a
 * content script).
 */
export function extractGeneric(doc: Document, url: URL): ExtractorResult {
  const title = (doc.title || "Untitled").trim();
  const region = pickRegion(doc);
  const raw = (region?.innerText || region?.textContent || doc.body.innerText || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const content = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;

  if (!content) {
    throw new Error(
      "No readable text on this page — select content manually and use the selection button instead.",
    );
  }

  return {
    content,
    title,
    source: "manual",
    suggestedType: "doc",
    sourceId: `page:${hashUrl(url.toString())}`,
    sourceUrl: url.toString(),
  };
}

/**
 * Pick the densest article-like element. We prefer <article> then
 * <main>, tiebreaking by visible text length. Falls back to <body>.
 */
function pickRegion(doc: Document): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  candidates.push(...Array.from(doc.querySelectorAll("article")) as HTMLElement[]);
  candidates.push(...Array.from(doc.querySelectorAll("main")) as HTMLElement[]);
  candidates.push(
    ...(Array.from(
      doc.querySelectorAll("[role='main'], [role='article']"),
    ) as HTMLElement[]),
  );

  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const el of candidates) {
    const len = (el.innerText || el.textContent || "").length;
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  return best ?? doc.body;
}
