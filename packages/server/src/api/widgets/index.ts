import type { CacheStorage } from "@onenomad/cortex-cache-sqlite";
import type { Widget } from "../types.js";
import { withCache, type WithCacheOptions } from "../cache/wrap.js";
import { codeActivityWidget } from "./code-activity.js";
import { myActionItemsWidget } from "./my-action-items.js";
import { prioritiesWidget } from "./priorities.js";
import { recentActivityWidget } from "./recent-activity.js";
import { recentDecisionsWidget } from "./recent-decisions.js";
import { todayMeetingsWidget } from "./today-meetings.js";
import { todayTimelineWidget } from "./today-timeline.js";
import { upcomingBriefsWidget } from "./upcoming-briefs.js";
import { whoKnowsWidget } from "./who-knows.js";

/**
 * Per-widget cache profiles (ADR-019 Phase 2). TTL is how long we treat
 * a cached entry as fresh; after that the wrapper serves the stale
 * value AND fires a background refresh, so steady-state dashboard
 * loads stay fast.
 *
 * Numbers reflect how often the underlying data actually changes, not
 * how often the dashboard polls:
 *   - meetings/calendar: minutes — calendar adapter syncs hourly
 *   - action items / decisions / activity: ~1 minute — these update
 *     whenever a meeting transcript or doc lands in engram
 *   - code-activity / who-knows: a few minutes — bitbucket adapter
 *     polls on its own cadence
 *
 * If a widget feels stale, lower its ttl here. If a widget is fast
 * already (todayTimeline returns in ms because it's pure aggregation
 * over already-cached calls), don't wrap it — caching round-trippable
 * fast paths just adds a SQLite read.
 */
const WIDGET_CACHE_PROFILES: Record<string, WithCacheOptions> = {
  priorities: { ttlSeconds: 60 },
  "my-action-items": { ttlSeconds: 60 },
  "recent-decisions": { ttlSeconds: 120 },
  "recent-activity": { ttlSeconds: 120 },
  "today-meetings": { ttlSeconds: 300 },
  "upcoming-briefs": { ttlSeconds: 300 },
  "code-activity": { ttlSeconds: 180 },
  "who-knows": { ttlSeconds: 300 },
};

/**
 * Build the widget registry. ADR-019 Phase 2 wraps every widget with a
 * known cache profile in `WIDGET_CACHE_PROFILES`; widgets without a
 * profile (today-timeline) pass through unwrapped.
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
    todayTimelineWidget,
    maybeCache(prioritiesWidget),
    maybeCache(myActionItemsWidget),
    maybeCache(recentDecisionsWidget),
    maybeCache(recentActivityWidget),
    maybeCache(todayMeetingsWidget),
    maybeCache(upcomingBriefsWidget),
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
