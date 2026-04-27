import type { CacheStorage } from "@onenomad/cortex-cache-sqlite";
import type { Widget } from "../types.js";
import { withCache } from "../cache/wrap.js";
import { codeActivityWidget } from "./code-activity.js";
import { myActionItemsWidget } from "./my-action-items.js";
import { prioritiesWidget } from "./priorities.js";
import { recentActivityWidget } from "./recent-activity.js";
import { recentDecisionsWidget } from "./recent-decisions.js";
import { todayMeetingsWidget } from "./today-meetings.js";
import { upcomingBriefsWidget } from "./upcoming-briefs.js";
import { whoKnowsWidget } from "./who-knows.js";

/**
 * Build the widget registry. Phase 1 of ADR-019 wraps `prioritiesWidget`
 * with a SQLite cache; the other 7 widgets pass through unwrapped.
 *
 * Cache injection is a parameter rather than a module-level singleton so
 * tests can pass `cache=undefined` and exercise the registry without
 * dragging the cache-sqlite package (and its `node:sqlite` import) into
 * the vite transform graph. Production callers pass a real cache from
 * server.ts startup.
 */
export function buildWidgetRegistry(cache?: CacheStorage): readonly Widget[] {
  return [
    cache ? withCache(prioritiesWidget, cache) : prioritiesWidget,
    myActionItemsWidget,
    recentDecisionsWidget,
    recentActivityWidget,
    todayMeetingsWidget,
    upcomingBriefsWidget,
    codeActivityWidget,
    whoKnowsWidget,
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
