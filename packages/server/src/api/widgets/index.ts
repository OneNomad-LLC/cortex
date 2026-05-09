import type { CacheStorage } from "@onenomad/cortex-cache-sqlite";
import type { Widget } from "../types.js";
import { withCache, type WithCacheOptions } from "../cache/wrap.js";
import { codeActivityWidget } from "./code-activity.js";
import { recentActivityWidget } from "./recent-activity.js";
import { recentDecisionsWidget } from "./recent-decisions.js";
import { whoKnowsWidget } from "./who-knows.js";

/**
 * Per-widget cache profiles (ADR-019 Phase 2). TTL is how long we treat
 * a cached entry as fresh; after that the wrapper serves the stale
 * value AND fires a background refresh, so steady-state dashboard
 * loads stay fast.
 *
 * Numbers reflect how often the underlying data actually changes, not
 * how often the dashboard polls:
 *   - decisions / activity: ~1-2 minutes — these update whenever a
 *     meeting transcript or doc lands in engram
 *   - code-activity / who-knows: a few minutes — bitbucket adapter
 *     polls on its own cadence
 *
 * Knowledge-engine repositioning (Phase 1B): personal-priority widgets
 * (priorities, my-action-items, today-meetings, today-timeline,
 * upcoming-briefs) were removed from this registry. The cache profile
 * map mirrors what's left.
 */
const WIDGET_CACHE_PROFILES: Record<string, WithCacheOptions> = {
  "recent-decisions": { ttlSeconds: 120 },
  "recent-activity": { ttlSeconds: 120 },
  "code-activity": { ttlSeconds: 180 },
  "who-knows": { ttlSeconds: 300 },
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
  return [
    maybeCache(recentDecisionsWidget),
    maybeCache(recentActivityWidget),
    maybeCache(codeActivityWidget),
    maybeCache(whoKnowsWidget),
  ];
}

/**
 * Default registry — used in contexts that import the widget list
 * statically (api/server.ts uses buildWidgetRegistry directly with the
 * cache). Always cache-less; this constant exists for backwards-compat
 * with any external import.
 */
export const ALL_WIDGETS: readonly Widget[] = buildWidgetRegistry();

export const WIDGETS_BY_NAME: ReadonlyMap<string, Widget> = new Map(
  ALL_WIDGETS.map((w) => [w.name, w]),
);
