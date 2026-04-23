import type { Widget } from "../types.js";
import { codeActivityWidget } from "./code-activity.js";
import { myActionItemsWidget } from "./my-action-items.js";
import { prioritiesWidget } from "./priorities.js";
import { recentActivityWidget } from "./recent-activity.js";
import { recentDecisionsWidget } from "./recent-decisions.js";
import { todayMeetingsWidget } from "./today-meetings.js";
import { upcomingBriefsWidget } from "./upcoming-briefs.js";
import { whoKnowsWidget } from "./who-knows.js";

/**
 * Widget registry. Add a new widget by importing it here and adding it to
 * the array. `/api/widgets` lists these; `/api/widgets/<name>` invokes them.
 */
export const ALL_WIDGETS: readonly Widget[] = [
  prioritiesWidget,
  myActionItemsWidget,
  recentDecisionsWidget,
  recentActivityWidget,
  todayMeetingsWidget,
  upcomingBriefsWidget,
  codeActivityWidget,
  whoKnowsWidget,
];

export const WIDGETS_BY_NAME: ReadonlyMap<string, Widget> = new Map(
  ALL_WIDGETS.map((w) => [w.name, w]),
);
