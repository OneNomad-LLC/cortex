import { mountFloatingUi } from "./floating-button";
import { extractForCurrentPage } from "../lib/extractors";
import { extractGeneric } from "../lib/extractors/generic";
import type {
  InboundMessage,
  OutboundMessage,
  ExtractorResult,
} from "../lib/types";

/**
 * Content script entry. Injected into every page at document_idle.
 *
 * Responsibilities:
 *  1) Selection UX: show a floating "⊕ Cortex" button next to the
 *     selection when it's non-trivial; clicking sends INGEST_SELECTION
 *     to the background worker.
 *  2) Remote extractor: respond to EXTRACT_THREAD / EXTRACT_PAGE
 *     messages from the popup + background (context-menu flow).
 *  3) In-page toasts: show success/failure when background replies.
 *
 * All DOM we add lives in a closed shadow root so page CSS can't
 * mangle us.
 */

const MIN_SELECTION_CHARS = 20;
const ui = mountFloatingUi();

let lastSelectedText = "";

document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    ui.hideButton();
    lastSelectedText = "";
    return;
  }
  const text = sel.toString().trim();
  if (text.length < MIN_SELECTION_CHARS) {
    ui.hideButton();
    lastSelectedText = "";
    return;
  }
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    ui.hideButton();
    return;
  }
  lastSelectedText = text;
  ui.showButton(rect, () => {
    const payload: InboundMessage = {
      type: "INGEST_SELECTION",
      content: lastSelectedText,
      url: location.href,
      title: document.title,
    };
    ui.hideButton();
    void chrome.runtime
      .sendMessage(payload)
      .then((resp: OutboundMessage | undefined) => {
        if (!resp) {
          ui.toast("Ingested (no response)", "info");
          return;
        }
        if (resp.type === "INGEST_RESULT") {
          ui.toast(
            resp.ok
              ? `Ingested ${resp.count ?? 1} memor${(resp.count ?? 1) === 1 ? "y" : "ies"}`
              : `Ingest failed: ${resp.error ?? "unknown error"}`,
            resp.ok ? "success" : "error",
          );
        }
      })
      .catch((err: unknown) => {
        ui.toast(
          `Ingest failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      });
  });
});

/**
 * Also hide the button on click-elsewhere — the selectionchange event
 * doesn't always fire on clicks inside the page chrome.
 */
document.addEventListener("mousedown", (e) => {
  const host = document.getElementById("cortex-floating-host");
  if (host && e.target instanceof Node && host.contains(e.target)) return;
  // Give the selection a tick to settle before hiding.
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.toString().trim().length < MIN_SELECTION_CHARS) {
      ui.hideButton();
    }
  }, 50);
});

chrome.runtime.onMessage.addListener(
  (msg: InboundMessage, _sender, sendResponse: (r: OutboundMessage) => void) => {
    if (msg.type === "EXTRACT_THREAD") {
      try {
        const result = extractForCurrentPage(document, new URL(location.href));
        sendResponse({ type: "EXTRACT_RESULT", ok: true, result });
      } catch (err) {
        // If the site-specific extractor throws, fall back to generic
        // so the user always gets *something* back.
        try {
          const fallback = extractGeneric(document, new URL(location.href));
          sendResponse({ type: "EXTRACT_RESULT", ok: true, result: fallback });
        } catch (err2) {
          sendResponse({
            type: "EXTRACT_RESULT",
            ok: false,
            error: err2 instanceof Error ? err2.message : String(err2),
          });
        }
      }
      return false; // sync response
    }

    if (msg.type === "EXTRACT_PAGE") {
      try {
        const result = extractGeneric(document, new URL(location.href));
        sendResponse({ type: "EXTRACT_RESULT", ok: true, result });
      } catch (err) {
        sendResponse({
          type: "EXTRACT_RESULT",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    }

    if (msg.type === "INGEST_RESULT") {
      // Background finished a context-menu-initiated ingest; reflect it.
      const ok = msg.ok === true;
      ui.toast(
        ok
          ? `Ingested ${msg.count ?? 1} memor${(msg.count ?? 1) === 1 ? "y" : "ies"}`
          : `Ingest failed: ${msg.error ?? "unknown error"}`,
        ok ? "success" : "error",
      );
      return false;
    }

    return false;
  },
);

/**
 * Exported for the rare case a future agentic tool (phase 2) wants to
 * ask the page for an extraction synchronously. Keeping the hook here
 * so the entry point is discoverable; no-op until that bridge lands.
 */
export function _inPageExtract(): ExtractorResult {
  return extractForCurrentPage(document, new URL(location.href));
}
