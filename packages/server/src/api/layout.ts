import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { resolveLocalFirst } from "../config.js";

/**
 * A single widget slot on the dashboard. `props` is passed to the widget's
 * server handler as query-string params; the dashboard forwards whatever's
 * here to `/api/widgets/<name>?...`.
 */
export const layoutWidgetSchema = z.object({
  name: z.string().min(1),
  props: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const roleSchema = z
  .enum(["delivery", "developer", "custom"])
  .default("delivery");

/**
 * dashboard.yaml contract. `role` picks a preset; `widgets`, if present,
 * either replaces the preset (when `role: custom`) or overrides/extends it.
 */
export const dashboardLayoutSchema = z.object({
  role: roleSchema,
  widgets: z.array(layoutWidgetSchema).default([]),
});

export type LayoutWidget = z.infer<typeof layoutWidgetSchema>;
export type Role = z.infer<typeof roleSchema>;
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/**
 * Role presets. Baked in so `dashboard.yaml` is optional — if the user never
 * creates one, `loadDashboardLayout` returns the `delivery` preset as-is.
 *
 * Matt's role is delivery/PM, so that's the default. Developer preset exists
 * for when another teammate (or future-Matt in a code-heavy stretch) wants
 * to flip it without editing widgets by hand.
 *
 * Some widget names in these presets don't yet have server handlers
 * (today-meetings, recent-activity, code-activity). The dashboard renders
 * an "upcoming" placeholder for unknown names so presets can reference
 * widgets that ship in later sprints without breaking the page.
 */
export const ROLE_PRESETS: Record<Exclude<Role, "custom">, LayoutWidget[]> = {
  delivery: [
    { name: "priorities", props: { limit: 20 } },
    { name: "today-meetings", props: {} },
    { name: "upcoming-briefs", props: { hoursAhead: 24, limit: 3 } },
    { name: "my-action-items", props: { limit: 25 } },
    { name: "recent-decisions", props: { days: 7, limit: 15 } },
    { name: "recent-activity", props: { days: 3 } },
  ],
  developer: [
    { name: "my-action-items", props: { limit: 25 } },
    { name: "code-activity", props: { days: 3 } },
    { name: "recent-decisions", props: { days: 14, limit: 15 } },
    { name: "priorities", props: { limit: 15 } },
  ],
};

/**
 * Resolves the effective widget list for a layout. If `role` is `custom`,
 * the explicit `widgets` list wins outright. Otherwise the preset is used,
 * and any entry in `widgets` with a matching `name` overrides that
 * preset's props (merge, not replace). Names not in the preset are
 * appended in order.
 */
export function resolveLayout(layout: DashboardLayout): {
  role: Role;
  widgets: LayoutWidget[];
} {
  if (layout.role === "custom") {
    return { role: "custom", widgets: layout.widgets };
  }
  const preset = ROLE_PRESETS[layout.role];
  const overrideByName = new Map(layout.widgets.map((w) => [w.name, w]));
  const seen = new Set<string>();
  const merged: LayoutWidget[] = [];

  for (const base of preset) {
    seen.add(base.name);
    const override = overrideByName.get(base.name);
    if (override) {
      merged.push({
        name: base.name,
        props: { ...base.props, ...override.props },
      });
    } else {
      merged.push(base);
    }
  }
  for (const extra of layout.widgets) {
    if (!seen.has(extra.name)) merged.push(extra);
  }
  return { role: layout.role, widgets: merged };
}

/**
 * Loads `dashboard.yaml` if present, falls back to the delivery preset.
 * Same local-first resolution as `loadCortexConfig` — `dashboard.local.yaml`
 * wins over the committed template.
 */
export async function loadDashboardLayout(
  configPath: string,
): Promise<DashboardLayout> {
  const resolved = await resolveLocalFirst(configPath);
  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch {
    return { role: "delivery", widgets: [] };
  }
  const parsed: unknown = parseYaml(raw);
  if (parsed === null || parsed === undefined) {
    return { role: "delivery", widgets: [] };
  }
  return dashboardLayoutSchema.parse(parsed);
}
