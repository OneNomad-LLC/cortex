import { ingestToCortex } from "../lib/cortex-api";
import {
  DEFAULT_TYPE,
  getApiBase,
  getLastProject,
  getLastType,
  getScopeHosts,
  getScopeMode,
  pushRecentIngest,
} from "../lib/storage";
import type {
  ExtractorResult,
  InboundMessage,
  OutboundMessage,
} from "../lib/types";
import { Bridge } from "./bridge";
import { apiBaseToWsUrl } from "./scope";
import { startTabTracker, type TabTrackerHandle } from "./tab-tracker";

/**
 * Service worker — the extension's glue layer.
 *
 * - Registers context menus on install.
 * - Routes INGEST_SELECTION from the content script through the
 *   Cortex API.
 * - Routes context-menu clicks: ask the active tab's content script
 *   to extract, then ingest.
 * - Bumps the toolbar badge to "OK" / "x" so the user gets ambient
 *   feedback when a context-menu flow completes without opening the
 *   popup.
 * - Keeps a WebSocket bridge open to `ws://<api>/ws/browser` so
 *   Claude (via Cortex MCP) can drive this browser. Announces tab
 *   list + scope; executes inbound tool calls.
 */

const CONTEXT_MENU_IDS = {
  selection: "cortex-ingest-selection",
  thread: "cortex-ingest-thread",
} as const;

chrome.runtime.onInstalled.addListener(() => {
  // Remove any stale items first — switching from dev to packaged build
  // can leave duplicate menu ids that throw on re-create.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.selection,
      title: "Ingest selection to Cortex",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.thread,
      title: "Ingest thread to Cortex",
      contexts: ["page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === CONTEXT_MENU_IDS.selection) {
    const content = (info.selectionText ?? "").trim();
    if (!content) {
      setBadge("!", "#ca8a04");
      return;
    }
    void runIngest({
      content,
      title: tab.title ?? "Selection",
      url: info.pageUrl ?? tab.url ?? "",
      tabId: tab.id,
      sourceIdFallback: `selection:${Date.now()}`,
    });
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_IDS.thread) {
    void chrome.tabs
      .sendMessage(tab.id, { type: "EXTRACT_THREAD" } as InboundMessage)
      .then(async (resp: OutboundMessage | undefined) => {
        if (!resp || resp.type !== "EXTRACT_RESULT") {
          setBadge("?", "#ca8a04");
          return;
        }
        if (!resp.ok) {
          setBadge("x", "#dc2626");
          notifyTab(tab.id!, {
            type: "INGEST_RESULT",
            ok: false,
            error: resp.error,
          });
          return;
        }
        await runIngestExtracted(resp.result, tab.id!);
      })
      .catch((err: unknown) => {
        setBadge("x", "#dc2626");
        notifyTab(tab.id!, {
          type: "INGEST_RESULT",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
});

chrome.runtime.onMessage.addListener((msg: InboundMessage, sender, sendResponse) => {
  // Content-script-initiated flows (floating button). The popup uses
  // direct fetch via cortex-api, not this channel.
  if (msg.type === "INGEST_SELECTION") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({
        type: "INGEST_RESULT",
        ok: false,
        error: "no tab id",
      } as OutboundMessage);
      return false;
    }
    void runIngest({
      content: msg.content,
      title: msg.title,
      url: msg.url,
      tabId,
      sourceIdFallback: `selection:${hashString(msg.url)}:${Date.now()}`,
    }).then((result) => {
      sendResponse({
        type: "INGEST_RESULT",
        ok: result.ok,
        ...(result.ok ? { count: result.count } : { error: result.error }),
      } as OutboundMessage);
    });
    // We'll call sendResponse asynchronously — keep the channel open.
    return true;
  }
  return false;
});

interface SimpleIngestArgs {
  content: string;
  title: string;
  url: string;
  tabId: number;
  sourceIdFallback: string;
}

async function runIngest(
  args: SimpleIngestArgs,
): Promise<{ ok: boolean; error?: string; count?: number }> {
  const [apiBase, project, type] = await Promise.all([
    getApiBase(),
    getLastProject(),
    getLastType(),
  ]);

  if (!project) {
    const err =
      "No default project set — open the Cortex popup to pick one before using right-click ingest.";
    setBadge("x", "#dc2626");
    notifyTab(args.tabId, { type: "INGEST_RESULT", ok: false, error: err });
    return { ok: false, error: err };
  }

  const result = await ingestToCortex(apiBase, {
    content: args.content,
    project,
    type: type ?? DEFAULT_TYPE,
    sourceId: args.sourceIdFallback,
    title: args.title,
    sourceUrl: args.url,
    source: "manual",
  });

  if (result.ok) {
    setBadge("OK", "#16a34a");
    await pushRecentIngest({
      sourceId: args.sourceIdFallback,
      title: args.title,
      project,
      type: type ?? DEFAULT_TYPE,
      sourceUrl: args.url,
      at: new Date().toISOString(),
    });
    notifyTab(args.tabId, {
      type: "INGEST_RESULT",
      ok: true,
      ...(result.count !== undefined ? { count: result.count } : {}),
    });
  } else {
    setBadge("x", "#dc2626");
    notifyTab(args.tabId, {
      type: "INGEST_RESULT",
      ok: false,
      ...(result.error ? { error: result.error } : {}),
    });
  }
  return result;
}

async function runIngestExtracted(
  extracted: ExtractorResult,
  tabId: number,
): Promise<void> {
  const [apiBase, project, lastType] = await Promise.all([
    getApiBase(),
    getLastProject(),
    getLastType(),
  ]);
  if (!project) {
    setBadge("x", "#dc2626");
    notifyTab(tabId, {
      type: "INGEST_RESULT",
      ok: false,
      error:
        "No default project set — open the Cortex popup to pick one before using right-click ingest.",
    });
    return;
  }
  // Prefer the last user-chosen type over the extractor's suggestion
  // because the popup is the source of truth for user intent.
  const type = lastType ?? extracted.suggestedType;
  const result = await ingestToCortex(apiBase, {
    content: extracted.content,
    project,
    type,
    sourceId: extracted.sourceId,
    title: extracted.title,
    sourceUrl: extracted.sourceUrl,
    source: toCortexSource(extracted.source),
  });
  if (result.ok) {
    setBadge("OK", "#16a34a");
    await pushRecentIngest({
      sourceId: extracted.sourceId,
      title: extracted.title,
      project,
      type,
      sourceUrl: extracted.sourceUrl,
      at: new Date().toISOString(),
    });
    notifyTab(tabId, {
      type: "INGEST_RESULT",
      ok: true,
      ...(result.count !== undefined ? { count: result.count } : {}),
    });
  } else {
    setBadge("x", "#dc2626");
    notifyTab(tabId, {
      type: "INGEST_RESULT",
      ok: false,
      ...(result.error ? { error: result.error } : {}),
    });
  }
}

function toCortexSource(
  s: ExtractorResult["source"],
): "slack" | "email" | "teams" | "manual" {
  // Our ExtractorSource is already a subset of CortexSource so this
  // widens correctly. Kept as a function for clarity and to centralize
  // any future mapping changes.
  return s;
}

function notifyTab(tabId: number, msg: OutboundMessage): void {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // Tab may have navigated away — ignore; the badge already
    // conveys the result.
  });
}

/**
 * Flash a short badge. Chromium caps action.badgeText to 4 chars, so
 * we stick with short ASCII glyphs instead of the spec's ✓ / ✗.
 * Cleared automatically after a short delay.
 */
function setBadge(text: string, color: string): void {
  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setBadgeText({ text });
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: "" });
    // Restore whatever baseline the bridge has set (disconnected dot
    // or cleared badge when connected). Run after a microtask so the
    // bridge's own handler wins if it's flipped state since.
    void applyConnectionBadge();
  }, 2500);
}

/**
 * Fallback action click handler — the manifest's default_popup opens
 * the popup automatically. Still listening so later we can fall back
 * to a side panel or an injected UI when no popup is configured.
 */
chrome.action.onClicked.addListener(() => {
  // no-op; popup opens via manifest.
});

/* ========================================================================
 *  Browser-bridge: WS client + tab tracker + tool executor
 *  ====================================================================== */

let bridge: Bridge | undefined;
let tabTracker: TabTrackerHandle | undefined;
let connected = false;

// Rewire the connection baseline whenever tell-tale things change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if ("cortex.apiBase" in changes) {
    void reconnectBridge();
  }
  if ("cortex.scopeMode" in changes || "cortex.scopeHosts" in changes) {
    void pushScope();
  }
});

async function pushScope(): Promise<void> {
  if (!bridge) return;
  const [mode, hosts] = await Promise.all([getScopeMode(), getScopeHosts()]);
  bridge.sendScope(mode, hosts);
}

async function reconnectBridge(): Promise<void> {
  const apiBase = await getApiBase();
  const url = apiBaseToWsUrl(apiBase);
  if (!bridge) {
    bridge = new Bridge({
      onConnected: () => {
        connected = true;
        void applyConnectionBadge();
      },
      onDisconnected: () => {
        connected = false;
        void applyConnectionBadge();
      },
      flashBadge: (label) => flashBadge(label),
    });
  }
  bridge.connect(url);

  if (!tabTracker) {
    tabTracker = startTabTracker((tabs) => bridge?.sendTabs(tabs));
  }
  // Ensure scope is pushed with the current value immediately so the
  // initial connect frames carry user intent.
  await pushScope();
}

/**
 * Paint the toolbar badge based on WS state. Green dot = connected,
 * red dot = not. Tool-call flashes temporarily replace this and then
 * the post-flash timer calls us to restore baseline.
 */
async function applyConnectionBadge(): Promise<void> {
  if (connected) {
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Cortex — connected" });
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    await chrome.action.setBadgeText({ text: "•" });
    await chrome.action.setTitle({ title: "Cortex — disconnected" });
  }
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flashBadge(label: string): void {
  if (flashTimer) clearTimeout(flashTimer);
  void chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
  void chrome.action.setBadgeText({ text: label.slice(0, 2) });
  flashTimer = setTimeout(() => {
    flashTimer = undefined;
    void applyConnectionBadge();
  }, 900);
}

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

// Kick off the bridge on every SW lifecycle event that restarts us.
// Chrome MV3 evicts idle workers, so we wire up onStartup, onInstalled,
// and also run once when this module is imported — that's the path
// Chrome takes when an event (tab update, message) wakes us back up.
chrome.runtime.onStartup.addListener(() => {
  void reconnectBridge();
});
chrome.runtime.onInstalled.addListener(() => {
  void reconnectBridge();
});
void reconnectBridge();
void applyConnectionBadge();

/**
 * MV3 service-worker keepalive.
 *
 * Chrome evicts the service worker after ~30s idle. That kills the
 * WebSocket to Cortex — Claude's next browser tool call times out.
 * A chrome.alarms alarm firing every 25s is enough activity to keep
 * the SW warm, and the handler also verifies the WS is still open
 * and triggers a reconnect if it isn't.
 *
 * `chrome.alarms.create` is idempotent by name — safe to call on
 * every module load.
 */
const KEEPALIVE_ALARM = "cortex-bridge-keepalive";
chrome.alarms.create(KEEPALIVE_ALARM, {
  // periodInMinutes is a float; 25/60 keeps us below the 30s idle cap.
  periodInMinutes: 25 / 60,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!bridge || !bridge.isOpen()) {
    void reconnectBridge();
  }
});
