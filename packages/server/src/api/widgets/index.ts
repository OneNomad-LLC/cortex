import type { CacheStorage } from "@onenomad/cortex-cache-sqlite";
import type { Widget } from "../types.js";
import { withCache, type WithCacheOptions } from "../cache/wrap.js";
import { recentActivityWidget } from "./recent-activity.js";

/**
 * Per-widget cache profiles (ADR-019 Phase 2). TTL is how long we treat
 * a cached entry as fresh; after that the wrapper serves the stale
 * value AND fires a background refresh, so steady-state dashboard
 * loads stay fast.
 *
 * Knowledge-engine repositioning (2026-05-09 → 2026-05-14): the personal-
 * priority widgets and the cross-project surfaces (who-knows,
 * recent-decisions, code-activity) were both retired. Only
 * `recent-activity` remains. New widgets land alongside new
 * adapters/connectors, one widget per connector when warranted.
 */
const WIDGET_CACHE_PROFILES: Record<string, WithCacheOptions> = {
  "recent-activity": { ttlSeconds: 120 },
};

/**
 * Build the widget registry. ADR-019 Phase 2 wraps every widget with a
 * known cache profile in `WIDGET_CACHE_PROFILES`; widgets without a
 * profile pass through unwrapped.
 *
 * Cache injection is a parameter rather than a module-level singleton so
 * tests can pass `cache=undefined` and exercise the registry without
 * dragging the cache-sqlite package (and its `node:sqlite` import) into
 * the vite transform graph. Production callers pass a real cache from
 * server.ts startup.
 */
export function buildWidgetRegistry(cache?: CacheStorage): readonly Widget[] {
  function maybeCache<T>(w: Widget<T>): Widget<T> {
    if (!cache) return w;
    const profile = WIDGET_CACHE_PROFILES[w.name];
    if (!profile) return w;
    return withCache(w, cache, profile);
  }
  return [maybeCache(recentActivityWidget)];
}

/**
 * Default registry — used in contexts that import the widget list
 * statically. Always cache-less; this constant exists for back-compat
 * with any external import.
 */
export const ALL_WIDGETS: readonly Widget[] = buildWidgetRegistry();

export const WIDGETS_BY_NAME: ReadonlyMap<string, Widget> = new Map(
  ALL_WIDGETS.map((w) => [w.name, w]),
);
