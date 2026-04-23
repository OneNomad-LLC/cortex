import { MyActionItemsWidget } from "./my-action-items";
import { PlaceholderWidget } from "./placeholder";
import { PrioritiesWidget } from "./priorities";
import { RecentDecisionsWidget } from "./recent-decisions";

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
  "my-action-items": MyActionItemsWidget as WidgetComponent,
  "recent-decisions": RecentDecisionsWidget as WidgetComponent,
};

export function renderWidget(entry: LayoutWidget): React.ReactNode {
  const Component = WIDGET_COMPONENTS[entry.name];
  if (!Component) return <PlaceholderWidget name={entry.name} />;
  return Component(entry.props);
}
