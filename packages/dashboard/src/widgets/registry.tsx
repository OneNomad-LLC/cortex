import { CodeActivityWidget } from "./code-activity";
import { PlaceholderWidget } from "./placeholder";
import { PrioritiesWidget } from "./priorities";
import { RecentActivityWidget } from "./recent-activity";
import { RecentDecisionsWidget } from "./recent-decisions";
import { TodayMeetingsWidget } from "./today-meetings";
import { WhoKnowsWidget } from "./who-knows";

/**
 * Layout entry as served by GET /api/layout. Matches the zod schema in
 * packages/server/src/api/layout.ts. Deliberately duplicated rather than
 * imported — dashboard stays a thin HTTP client (ADR-015).
 */
export interface LayoutWidget {
  name: string;
  props: Record<string, string | number | boolean>;
}

export interface ResolvedLayout {
  role: "delivery" | "developer" | "custom";
  widgets: LayoutWidget[];
  /**
   * Optional workspace slug. Present when the user has adopted
   * workspaces via `cortex workspace add/switch`. Absent for legacy
   * single-config installs.
   */
  workspace?: string;
}

type WidgetComponent = (props: Record<string, unknown>) => React.ReactNode;

/**
 * Server-side component map. Layout arrives with widget names as strings;
 * this map turns a name into a renderable component. Unknown names fall
 * back to `PlaceholderWidget` so presets referencing future widgets don't
 * crash the page.
 */
export const WIDGET_COMPONENTS: Record<string, WidgetComponent> = {
  priorities: PrioritiesWidget as WidgetComponent,
  "recent-decisions": RecentDecisionsWidget as WidgetComponent,
  "recent-activity": RecentActivityWidget as WidgetComponent,
  "today-meetings": TodayMeetingsWidget as WidgetComponent,
  // upcoming-briefs removed in Phase 1B (2026-05-09). Stale presets
  // referencing it fall back to PlaceholderWidget via the `if
  // (!Component)` branch below.
  "code-activity": CodeActivityWidget as WidgetComponent,
  "who-knows": WhoKnowsWidget as WidgetComponent,
};

export function renderWidget(
  entry: LayoutWidget,
  workspace?: string,
): React.ReactNode {
  const Component = WIDGET_COMPONENTS[entry.name];
  if (!Component) return <PlaceholderWidget name={entry.name} />;
  // Thread the resolved workspace into every widget. Widgets forward it as
  // `?workspace=<slug>` on their fetch URL so server-side handlers can
  // filter by workspace (1b — backend filtering still pending). 1a wire
  // is purely additive: handlers that don't know `workspace` ignore it.
  const props = workspace ? { ...entry.props, workspace } : entry.props;
  return Component(props);
}
