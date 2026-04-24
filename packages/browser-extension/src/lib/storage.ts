import type { CortexType, RecentIngest } from "./types";

/**
 * Typed wrapper around `chrome.storage.sync`. All keys are namespaced
 * with "cortex." so a future Engram or Persona extension won't step
 * on us inside the same browser profile.
 */

export type ScopeMode = "all" | "active" | "allowlist";

interface StorageShape {
  "cortex.apiBase": string;
  "cortex.dashboardBase": string;
  "cortex.lastProject": string;
  "cortex.lastType": CortexType;
  "cortex.recentIngests": RecentIngest[];
  /** Which tabs the WS bridge will advertise to Claude. */
  "cortex.scopeMode": ScopeMode;
  /** Host-prefix allowlist (used when scopeMode === "allowlist"). */
  "cortex.scopeHosts": string[];
  /** Hosts the user has paused — bridge hides their tabs from Claude. */
  "cortex.pausedHosts": string[];
}

export const DEFAULT_API_BASE = "http://localhost:4141";
export const DEFAULT_DASHBOARD_BASE = "http://localhost:3030";
export const DEFAULT_TYPE: CortexType = "doc";
export const DEFAULT_SCOPE_MODE: ScopeMode = "all";
const RECENT_LIMIT = 20;

async function rawGet<K extends keyof StorageShape>(
  key: K,
): Promise<StorageShape[K] | undefined> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(key, (items) => {
      resolve(items[key] as StorageShape[K] | undefined);
    });
  });
}

async function rawSet<K extends keyof StorageShape>(
  key: K,
  value: StorageShape[K],
): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [key]: value }, () => resolve());
  });
}

export async function getApiBase(): Promise<string> {
  const v = await rawGet("cortex.apiBase");
  return typeof v === "string" && v.length > 0 ? v : DEFAULT_API_BASE;
}

export async function setApiBase(value: string): Promise<void> {
  const clean = value.trim().replace(/\/+$/, "");
  await rawSet("cortex.apiBase", clean || DEFAULT_API_BASE);
}

export async function getDashboardBase(): Promise<string> {
  const v = await rawGet("cortex.dashboardBase");
  return typeof v === "string" && v.length > 0 ? v : DEFAULT_DASHBOARD_BASE;
}

export async function setDashboardBase(value: string): Promise<void> {
  const clean = value.trim().replace(/\/+$/, "");
  await rawSet("cortex.dashboardBase", clean || DEFAULT_DASHBOARD_BASE);
}

export async function getLastProject(): Promise<string> {
  return (await rawGet("cortex.lastProject")) ?? "";
}

export async function setLastProject(slug: string): Promise<void> {
  await rawSet("cortex.lastProject", slug);
}

export async function getLastType(): Promise<CortexType> {
  return (await rawGet("cortex.lastType")) ?? DEFAULT_TYPE;
}

export async function setLastType(type: CortexType): Promise<void> {
  await rawSet("cortex.lastType", type);
}

export async function getRecentIngests(): Promise<RecentIngest[]> {
  return (await rawGet("cortex.recentIngests")) ?? [];
}

/**
 * Prepend a new entry, dedupe by sourceId (most-recent wins), cap at
 * RECENT_LIMIT. Kept to 20 so we stay comfortably under the 8k/item
 * limit chrome.storage.sync imposes — even with long titles.
 */
export async function pushRecentIngest(entry: RecentIngest): Promise<void> {
  const current = await getRecentIngests();
  const filtered = current.filter((r) => r.sourceId !== entry.sourceId);
  filtered.unshift(entry);
  await rawSet("cortex.recentIngests", filtered.slice(0, RECENT_LIMIT));
}

/* ---------------- Scope + pause --------------------------------------
 * Scope controls which tabs the extension advertises to the server.
 * `pausedHosts` is independent of scope — paused tabs never surface
 * regardless of mode.
 */

export async function getScopeMode(): Promise<ScopeMode> {
  const v = await rawGet("cortex.scopeMode");
  return v === "all" || v === "active" || v === "allowlist"
    ? v
    : DEFAULT_SCOPE_MODE;
}

export async function setScopeMode(mode: ScopeMode): Promise<void> {
  await rawSet("cortex.scopeMode", mode);
}

export async function getScopeHosts(): Promise<string[]> {
  const v = await rawGet("cortex.scopeHosts");
  return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
}

export async function setScopeHosts(hosts: string[]): Promise<void> {
  const clean = dedupeHosts(hosts);
  await rawSet("cortex.scopeHosts", clean);
}

export async function getPausedHosts(): Promise<string[]> {
  const v = await rawGet("cortex.pausedHosts");
  return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
}

export async function setPausedHosts(hosts: string[]): Promise<void> {
  await rawSet("cortex.pausedHosts", dedupeHosts(hosts));
}

export async function pauseHost(host: string): Promise<void> {
  const current = await getPausedHosts();
  const h = host.trim().toLowerCase();
  if (!h || current.includes(h)) return;
  await setPausedHosts([...current, h]);
}

export async function unpauseHost(host: string): Promise<void> {
  const current = await getPausedHosts();
  const h = host.trim().toLowerCase();
  const next = current.filter((x) => x !== h);
  if (next.length !== current.length) await setPausedHosts(next);
}

function dedupeHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hosts) {
    const h = String(raw).trim().toLowerCase();
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}
