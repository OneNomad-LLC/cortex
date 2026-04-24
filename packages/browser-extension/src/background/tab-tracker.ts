/**
 * Tab-list tracker. Keeps a debounced, scope-filtered view of the
 * user's open tabs and pushes it through a supplied sender.
 *
 * Chrome fires tab events in thick bursts (typing into the URL bar
 * flips `onUpdated` N times as the autocomplete updates). A 250ms
 * trailing-edge debounce smooths that into a single WS frame.
 */

import {
  getPausedHosts,
  getScopeHosts,
  getScopeMode,
  type ScopeMode,
} from "../lib/storage";
import { applyScope, type AdvertisedTab } from "./scope";

type Sender = (tabs: AdvertisedTab[]) => void;

const DEBOUNCE_MS = 250;

export interface TabTrackerHandle {
  /** Force-send the current list now (useful right after connect). */
  flush(): Promise<void>;
  /** Dispose event listeners. */
  destroy(): void;
}

export function startTabTracker(send: Sender): TabTrackerHandle {
  let pending: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      void flush();
    }, DEBOUNCE_MS);
  };

  const flush = async (): Promise<void> => {
    const [mode, hosts, paused] = await Promise.all([
      getScopeMode(),
      getScopeHosts(),
      getPausedHosts(),
    ]);
    const rawTabs = await chrome.tabs.query({});
    // `chrome.tabs.query({})` returns one `active: true` per window,
    // and when the service worker is waking from idle the field can
    // be missing entirely. Re-derive "globally focused" explicitly:
    // the single active tab of the last-focused window is the one
    // Claude should treat as "the tab you're on."
    const focusedRes = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const focusedId =
      focusedRes.length > 0 && typeof focusedRes[0]!.id === "number"
        ? focusedRes[0]!.id
        : undefined;
    const tabs: AdvertisedTab[] = rawTabs
      .filter((t): t is chrome.tabs.Tab & { id: number } => typeof t.id === "number")
      .filter((t) => !!t.url && !isInternalUrl(t.url))
      .map((t) => ({
        id: t.id,
        url: t.url ?? "",
        title: t.title ?? "",
        active: focusedId !== undefined && t.id === focusedId,
      }));
    const filtered = applyScope(tabs, {
      mode,
      hosts,
      pausedHosts: paused,
    });
    send(filtered);
  };

  const onCreated = (_tab: chrome.tabs.Tab): void => schedule();
  const onRemoved = (_id: number): void => schedule();
  const onActivated = (_info: chrome.tabs.TabActiveInfo): void => schedule();
  const onUpdated = (
    _id: number,
    info: chrome.tabs.TabChangeInfo,
  ): void => {
    // Most onUpdated fires don't change anything the server cares
    // about (favicon, audible, mutedInfo). Filter to the fields that
    // appear in AdvertisedTab.
    if (
      info.url !== undefined ||
      info.title !== undefined ||
      info.status === "complete"
    ) {
      schedule();
    }
  };

  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  // Storage changes that affect filtering should re-push the list.
  const onStorage = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== "sync") return;
    if (
      "cortex.scopeMode" in changes ||
      "cortex.scopeHosts" in changes ||
      "cortex.pausedHosts" in changes
    ) {
      schedule();
    }
  };
  chrome.storage.onChanged.addListener(onStorage);

  // Fire once so the server sees us immediately after the socket
  // opens, instead of waiting for the first tab event.
  schedule();

  return {
    flush,
    destroy(): void {
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.storage.onChanged.removeListener(onStorage);
      if (pending) clearTimeout(pending);
    },
  };
}

/**
 * Hide chrome:// / chrome-extension:// / devtools:// from the list —
 * scripting against them is denied anyway, and exposing them to the
 * server would clutter Claude's view.
 */
function isInternalUrl(url: string): boolean {
  return (
    url.startsWith("chrome:") ||
    url.startsWith("chrome-extension:") ||
    url.startsWith("devtools:") ||
    url.startsWith("edge:") ||
    url.startsWith("about:") ||
    url === "" ||
    url === "about:blank"
  );
}

export type { ScopeMode };
