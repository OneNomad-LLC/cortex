import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dashboardLayoutSchema,
  loadDashboardLayout,
  resolveLayout,
  ROLE_PRESETS,
} from "../src/api/layout.js";

describe("dashboard layout", () => {
  it("delivery preset is returned as-is when no overrides", () => {
    const out = resolveLayout({ role: "delivery", widgets: [] });
    expect(out.role).toBe("delivery");
    expect(out.widgets.map((w) => w.name)).toEqual(
      ROLE_PRESETS.delivery.map((w) => w.name),
    );
  });

  it("merges props for a matching preset entry", () => {
    const out = resolveLayout({
      role: "delivery",
      widgets: [{ name: "recent-decisions", props: { limit: 42, days: 21 } }],
    });
    const decisions = out.widgets.find((w) => w.name === "recent-decisions");
    expect(decisions?.props).toEqual({ limit: 42, days: 21 });
    // Other preset widgets are untouched.
    expect(out.widgets.length).toBe(ROLE_PRESETS.delivery.length);
  });

  it("appends new widget names that aren't in the preset", () => {
    const out = resolveLayout({
      role: "delivery",
      widgets: [{ name: "future-widget", props: { foo: "bar" } }],
    });
    expect(out.widgets.at(-1)?.name).toBe("future-widget");
    expect(out.widgets.length).toBe(ROLE_PRESETS.delivery.length + 1);
  });

  it("role: custom ignores presets entirely", () => {
    const out = resolveLayout({
      role: "custom",
      widgets: [
        { name: "code-activity", props: { days: 5 } },
        { name: "recent-decisions", props: {} },
      ],
    });
    expect(out.role).toBe("custom");
    expect(out.widgets.map((w) => w.name)).toEqual([
      "code-activity",
      "recent-decisions",
    ]);
  });

  it("schema defaults missing fields", () => {
    const parsed = dashboardLayoutSchema.parse({});
    expect(parsed.role).toBe("delivery");
    expect(parsed.widgets).toEqual([]);
  });

  it("schema rejects an unknown role", () => {
    expect(() =>
      dashboardLayoutSchema.parse({ role: "ceo", widgets: [] }),
    ).toThrow();
  });

  it("loadDashboardLayout falls back to delivery when file is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cortex-layout-"));
    try {
      const out = await loadDashboardLayout(
        path.join(dir, "does-not-exist.yaml"),
      );
      expect(out.role).toBe("delivery");
      expect(out.widgets).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadDashboardLayout prefers .local.yaml over the template", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cortex-layout-"));
    try {
      await writeFile(
        path.join(dir, "dashboard.yaml"),
        "role: delivery\nwidgets: []\n",
      );
      await writeFile(
        path.join(dir, "dashboard.local.yaml"),
        "role: developer\nwidgets: []\n",
      );
      const out = await loadDashboardLayout(
        path.join(dir, "dashboard.yaml"),
      );
      expect(out.role).toBe("developer");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
