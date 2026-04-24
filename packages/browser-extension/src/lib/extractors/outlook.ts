import type { ExtractorResult } from "../types";
import { hashUrl } from "./index";

/**
 * Outlook Web (OWA) extractor. Covers outlook.office.com,
 * outlook.office365.com, and outlook.live.com — they share the same
 * React shell. The mail reading pane uses ARIA roles reliably, so we
 * key on those first and fall back to class-based selectors.
 */
export function extractOutlook(doc: Document, url: URL): ExtractorResult {
  const subject = extractSubject(doc);
  const sender = extractSender(doc);
  const date = extractDate(doc);
  const body = extractBody(doc);

  if (!body) {
    throw new Error(
      "Outlook message body not found — open an email before ingesting.",
    );
  }

  const title = subject || "Outlook message";
  const pieces: string[] = [`# ${title}`];
  if (sender) pieces.push(`From: ${sender}`);
  if (date) pieces.push(`Date: ${date}`);
  pieces.push("");
  pieces.push(body);

  const content = pieces.join("\n");
  const sourceId = buildSourceId(url);

  return {
    content,
    title,
    source: "email",
    suggestedType: "conversation",
    sourceId,
    sourceUrl: url.toString(),
  };
}

function extractSubject(doc: Document): string {
  const heading = doc.querySelector(
    "[role='heading'][aria-level='2'], [role='heading'][aria-level='1']",
  );
  if (heading) {
    const t = heading.textContent?.trim();
    if (t) return t;
  }
  // Fallback: OWA sometimes labels the reading pane with data-testid.
  const subjectCell = doc.querySelector(
    "[data-testid='message-subject'], .allowTextSelection[role='heading']",
  );
  if (subjectCell) {
    const t = subjectCell.textContent?.trim();
    if (t) return t;
  }
  return doc.title.replace(/\s*[-—|]\s*Outlook.*$/i, "").trim();
}

function extractSender(doc: Document): string {
  const el = doc.querySelector(
    "[data-testid='message-sender'], .ms-font-weight-semibold[id^='OwaReadSender'], span[title*='<']",
  );
  if (!el) return "";
  const title = el.getAttribute("title");
  if (title && title.includes("<")) return title.trim();
  return el.textContent?.trim() ?? "";
}

function extractDate(doc: Document): string {
  const el = doc.querySelector(
    "[data-testid='SentReceivedSavedTime'], time, [aria-label*='Sent']",
  );
  if (!el) return "";
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  return el.textContent?.trim() ?? "";
}

function extractBody(doc: Document): string {
  // The rendered email body sits inside role="document". OWA shows a
  // reading pane for the active message which is typically the last
  // such node, so we prefer it.
  const docs = doc.querySelectorAll("[role='document']");
  const chosen = docs.length > 0 ? docs[docs.length - 1] : null;
  if (chosen) {
    const cloned = chosen.cloneNode(true) as HTMLElement;
    // Best-effort strip of inline reply-quote blocks so we don't ingest
    // the entire thread history when the user is reading the newest msg.
    cloned
      .querySelectorAll("blockquote, .gmail_quote, .ms-outlook-quoted")
      .forEach((n) => n.parentNode?.removeChild(n));
    const text = (cloned.innerText || cloned.textContent || "").trim();
    if (text) return text;
  }
  // Fallback: larger .wide-content-host region OWA wraps around the pane.
  const pane = doc.querySelector(".wide-content-host, #ReadingPaneContainerId");
  if (pane instanceof HTMLElement) {
    return (pane.innerText || pane.textContent || "").trim();
  }
  return "";
}

/**
 * OWA URLs embed an `ItemID` query param or path segment. We prefer
 * that as the dedupe key; otherwise hash the pathname so the same
 * message round-trips to the same sourceId.
 */
function buildSourceId(url: URL): string {
  const itemId =
    url.searchParams.get("ItemID") ??
    url.searchParams.get("itemId") ??
    url.searchParams.get("id") ??
    "";
  if (itemId) return `outlook:${itemId}`;
  return `outlook:${hashUrl(url.pathname + url.search)}`;
}
