import type { ExtractorResult } from "../types";
import { hashUrl } from "./index";

/**
 * Teams web extractor. Teams' DOM is the most dynamic of the three —
 * virtual scrolling + Angular/React hybrid shells + CSS-in-JS make
 * selectors brittle. We aim coarse: gather anything that looks like a
 * message body and stitch it together best-effort.
 */
export function extractTeams(doc: Document, url: URL): ExtractorResult {
  const messageSelectors = [
    "[data-tid='messageBodyContent']",
    "[data-tid='chat-pane-message']",
    ".ts-message-list-item",
    "[role='listitem'] [data-tid*='message']",
  ];

  const messageNodes = doc.querySelectorAll(messageSelectors.join(", "));
  if (messageNodes.length === 0) {
    throw new Error(
      "Teams messages not found — open a chat or channel before ingesting.",
    );
  }

  const title = extractTitle(doc);
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const node of Array.from(messageNodes)) {
    const el = node as HTMLElement;
    const sender = findSender(el);
    const text = (el.innerText || el.textContent || "").trim();
    if (!text) continue;
    const key = text.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    const header = sender ? `**${sender}**` : "";
    blocks.push(header ? `${header}\n${text}` : text);
  }

  if (blocks.length === 0) {
    throw new Error(
      "Teams messages matched but had no text — DOM may have changed.",
    );
  }

  const content = `# ${title}\n\n${blocks.join("\n\n")}`;
  return {
    content,
    title,
    source: "teams",
    suggestedType: "conversation",
    sourceId: `teams:${hashUrl(url.pathname + url.search)}`,
    sourceUrl: url.toString(),
  };
}

function extractTitle(doc: Document): string {
  const candidates = [
    "[data-tid='chat-pane-item-title']",
    "[data-tid='chat-header-title']",
    "[data-tid='channel-header-title']",
    "[data-tid='conversations-panel-header-item']",
    "header h1",
    "header [role='heading']",
  ];
  for (const sel of candidates) {
    const el = doc.querySelector(sel);
    const t = el?.textContent?.trim();
    if (t) return t;
  }
  return doc.title.replace(/\s*[-—|]\s*Microsoft Teams.*$/i, "").trim() || "Teams";
}

/**
 * Walk up from the message-body node and try to find the author the
 * message belongs to. Teams nests the sender next to the body rather
 * than inside it, so we search sibling and ancestor scopes before
 * giving up.
 */
function findSender(el: HTMLElement): string {
  const scope = el.closest(
    "[data-tid='chat-pane-message'], .ts-message-list-item, [role='listitem']",
  );
  if (!scope) return "";
  const sender = scope.querySelector(
    "[data-tid='message-author-name'], [data-tid='chat-pane-message-from'], .ui-text[aria-label*='said']",
  );
  const text = sender?.textContent?.trim();
  return text ?? "";
}
