import type { ScopeMode } from "../lib/storage";

/**
 * Scope + pause filtering for the tab list we advertise to the server.
 *
 * Kept separate from the WS client so the rules can be unit-tested
 * with plain objects — no chrome.* required.
 */

export interface AdvertisedTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export interface FilterInput {
  mode: ScopeMode;
  /** Host prefixes (lowercased) the user explicitly allowed. */
  hosts: string[];
  /** Hosts the user has paused on (lowercased, exact-match). */
  pausedHosts: string[];
}

/**
 * Apply the scope + pause rules to a list of raw tabs.
 *
 * Paused hosts are stripped first so the "Resume" button works the
 * same way regardless of scope. Then:
 *   - "all"       — return everything that survived the pause filter.
 *   - "active"    — only the tab with `active: true` (typically one).
 *   - "allowlist" — tabs whose host starts with any configured prefix.
 */
export function applyScope(
  tabs: AdvertisedTab[],
  filter: FilterInput,
): AdvertisedTab[] {
  const pausedSet = new Set(filter.pausedHosts.map((h) => h.toLowerCase()));
  const survivors = tabs.filter((t) => {
    const host = hostnameOf(t.url);
    return host && !pausedSet.has(host);
  });

  switch (filter.mode) {
    case "all":
      return survivors;
    case "active":
      return survivors.filter((t) => t.active);
    case "allowlist": {
      const prefixes = filter.hosts
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      if (prefixes.length === 0) return [];
      return survivors.filter((t) => {
        const host = hostnameOf(t.url);
        if (!host) return false;
        return prefixes.some((p) => host === p || host.startsWith(p));
      });
    }
    default:
      return survivors;
  }
}

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Derive the API base's ws origin. Swaps http→ws and https→wss.
 * Strips any path so `ws://host/ws/browser` is always what's used.
 */
export function apiBaseToWsUrl(apiBase: string, path = "/ws/browser"): string {
  // Fall back to localhost if the stored value is somehow empty.
  const raw = (apiBase ?? "").trim() || "http://localhost:4141";
  try {
    const u = new URL(raw);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = path;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return `ws://localhost:4141${path}`;
  }
}
