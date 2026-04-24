import type { ExtractorResult } from "../types";
import { hashUrl } from "./index";

/**
 * Slack web client extractor. Slack's DOM is stable-ish but the
 * classes are minified with a `c-` prefix that occasionally churns.
 * When selectors miss we throw with a descriptive error so the caller
 * can fall back gracefully.
 *
 * Strategy: find the virtual message list, iterate messages, build a
 * canonical markdown-ish transcript with `**sender** iso-ts\n text`.
 */
export function extractSlack(doc: Document, url: URL): ExtractorResult {
  const scrollContainer = doc.querySelector(
    ".c-virtual_list__scroll_container",
  );
  const messageNodes = doc.querySelectorAll(
    [
      ".c-message_kit__background",
      ".c-message_kit__message",
      ".c-virtual_list__item",
      ".c-message",
    ].join(", "),
  );

  if (!scrollContainer && messageNodes.length === 0) {
    throw new Error(
      "Slack message list not found — is a channel or thread open?",
    );
  }

  const title = extractTitle(doc);
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const node of Array.from(messageNodes)) {
    const block = messageBlock(node as HTMLElement);
    if (!block) continue;
    const key = block.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(block);
  }

  if (blocks.length === 0) {
    throw new Error(
      "Slack messages matched selectors but had no extractable text — DOM may have changed.",
    );
  }

  const content = `# ${title}\n\n${blocks.join("\n\n")}`;
  const sourceId = buildSourceId(url);

  return {
    content,
    title,
    source: "slack",
    suggestedType: "conversation",
    sourceId,
    sourceUrl: url.toString(),
  };
}

function extractTitle(doc: Document): string {
  const channelName = doc.querySelector(".p-view_header__channel_name");
  if (channelName) {
    const t = channelName.textContent?.trim();
    if (t) return `#${t.replace(/^#/, "")}`;
  }
  const dm = doc.querySelector(".p-view_header__title");
  if (dm) {
    const t = dm.textContent?.trim();
    if (t) return t;
  }
  const heading = doc.querySelector("[data-qa='channel_name']");
  if (heading) {
    const t = heading.textContent?.trim();
    if (t) return t;
  }
  return doc.title.replace(/\s*\|.*$/, "") || "Slack";
}

function messageBlock(node: HTMLElement): string | null {
  const senderEl = node.querySelector(
    ".c-message__sender_link, [data-qa='message_sender_name'], .c-message__sender_button",
  );
  const textEl = node.querySelector(
    ".c-message__body, [data-qa='message-text'], .p-rich_text_section",
  );
  if (!textEl) return null;

  const sender = senderEl?.textContent?.trim() || "unknown";
  const text = (textEl.textContent || "").trim();
  if (!text) return null;

  const tsEl = node.querySelector(".c-timestamp");
  const ts = tsEl?.getAttribute("data-ts");
  const iso = ts ? slackTsToIso(ts) : "";
  const header = iso ? `**${sender}** ${iso}` : `**${sender}**`;
  return `${header}\n${text}`;
}

function slackTsToIso(ts: string): string {
  // Slack ts is `<unixSeconds>.<micro>` — we only need seconds for a
  // human-readable timestamp in the transcript.
  const secs = Number.parseFloat(ts);
  if (!Number.isFinite(secs)) return "";
  return new Date(secs * 1000).toISOString();
}

/**
 * Slack web URLs look like:
 *   /client/<workspaceId>/<channelId>?thread_ts=...&cid=...
 *   /archives/<channelId>/p<messageTs>
 *
 * We key on (workspace, channel, thread_ts || first-message-ts) so a
 * thread view and the channel view produce different dedupe keys but
 * re-opening the same thread re-uses the same sourceId.
 */
function buildSourceId(url: URL): string {
  const parts = url.pathname.split("/").filter(Boolean);
  const workspace = parts[1] ?? "unknown";
  const channel = parts[2] ?? parts[1] ?? "unknown";
  const threadTs =
    url.searchParams.get("thread_ts") ??
    url.searchParams.get("ts") ??
    "";
  const suffix = threadTs ? `:thread:${threadTs}` : "";
  return `slack:${workspace}:${channel}${suffix}:${hashUrl(url.pathname + url.search)}`;
}
