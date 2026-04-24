import type { ExtractorResult } from "../types";
import { extractSlack } from "./slack";
import { extractOutlook } from "./outlook";
import { extractTeams } from "./teams";
import { extractGeneric } from "./generic";

/**
 * Dispatch to a per-host extractor based on URL. Each extractor is
 * best-effort — DOM structure on Slack/Outlook/Teams changes without
 * warning, so they throw with a clear message when selectors miss and
 * the caller falls back to the generic extractor.
 */
export function extractForCurrentPage(
  doc: Document,
  url: URL,
): ExtractorResult {
  const host = url.hostname.toLowerCase();

  if (host === "app.slack.com" || host.endsWith(".slack.com")) {
    return extractSlack(doc, url);
  }
  if (
    host === "outlook.office.com" ||
    host === "outlook.office365.com" ||
    host === "outlook.live.com"
  ) {
    return extractOutlook(doc, url);
  }
  if (
    host === "teams.microsoft.com" ||
    host === "teams.live.com" ||
    host.endsWith(".teams.microsoft.com")
  ) {
    return extractTeams(doc, url);
  }
  return extractGeneric(doc, url);
}

/**
 * Small, deterministic hash for URL-based dedupe ids. Not a security
 * primitive — just a stable digest so re-visiting the same page
 * doesn't create duplicate memories. djb2 is good enough and doesn't
 * require the subtle-crypto API (which is async in service workers).
 */
export function hashUrl(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Unsigned hex, 8 chars. Enough entropy for our dedupe purposes.
  return (hash >>> 0).toString(16).padStart(8, "0");
}
