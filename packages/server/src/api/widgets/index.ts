import type { Widget } from "../types.js";
import { prioritiesWidget } from "./priorities.js";

/**
 * Widget registry. Add a new widget by importing it here and adding it to
 * the array. `/api/widgets` lists these; `/api/widgets/<name>` invokes them.
 */
export const ALL_WIDGETS: readonly Widget[] = [prioritiesWidget];

export const WIDGETS_BY_NAME: ReadonlyMap<string, Widget> = new Map(
  ALL_WIDGETS.map((w) => [w.name, w]),
);
