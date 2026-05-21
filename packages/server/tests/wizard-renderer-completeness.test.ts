/**
 * CI guardrail: every `WizardStepKind` in cortex-core has a corresponding
 * renderer component in the dashboard's step-component registry. Adding
 * a new step kind without a renderer would silently produce a wizard
 * step that the dashboard can't render — this test catches the drift at
 * build time.
 *
 * The dashboard package isn't a runtime dep of the server, so instead of
 * importing the registry we read its source file and extract the kinds
 * declared in `STEP_COMPONENT_KINDS`. Brittle to formatting changes by
 * design — if the constant moves, this test should fail loudly so the
 * author can re-point it rather than silently passing.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WIZARD_STEP_KINDS } from "@onenomad/przm-cortex-core";

const DASHBOARD_REGISTRY_PATH = path.join(
  __dirname,
  "..",
  "..",
  "dashboard",
  "src",
  "components",
  "wizard",
  "steps",
  "index.ts",
);

/**
 * Pull the string literals out of:
 *
 *   export const STEP_COMPONENT_KINDS: ReadonlyArray<WizardStepKind> = [
 *     "text", "password", ...
 *   ] as const;
 *
 * Returns the kinds in declared order so a regression in ordering doesn't
 * break the assertion — Set comparison is what we actually care about.
 */
async function readDashboardKinds(): Promise<string[]> {
  const raw = await readFile(DASHBOARD_REGISTRY_PATH, "utf8");
  const match = raw.match(
    /STEP_COMPONENT_KINDS[^=]*=\s*\[([\s\S]*?)\]\s*as\s+const/,
  );
  if (!match) {
    throw new Error(
      `STEP_COMPONENT_KINDS not found in ${DASHBOARD_REGISTRY_PATH} — registry shape changed?`,
    );
  }
  const body = match[1]!;
  return Array.from(body.matchAll(/"([^"]+)"/g)).map((m) => m[1]!);
}

describe("dashboard wizard renderer completeness", () => {
  it("every WizardStepKind in core has a renderer registered", async () => {
    const dashboardKinds = new Set(await readDashboardKinds());
    const missing = WIZARD_STEP_KINDS.filter((kind) => !dashboardKinds.has(kind));
    expect(
      missing,
      `core declares step kinds the dashboard doesn't render: ${missing.join(
        ", ",
      )}. Add the matching component under packages/dashboard/src/components/wizard/steps/ and export it from steps/index.ts.`,
    ).toEqual([]);
  });

  it("the dashboard does not register kinds core doesn't know about", async () => {
    const dashboardKinds = await readDashboardKinds();
    const coreKinds = new Set<string>(WIZARD_STEP_KINDS);
    const extras = dashboardKinds.filter((kind) => !coreKinds.has(kind));
    expect(
      extras,
      `dashboard renders step kinds that aren't in core's WIZARD_STEP_KINDS: ${extras.join(
        ", ",
      )}. Add them to packages/core/src/wizard.ts.`,
    ).toEqual([]);
  });

  it("the dashboard registry imports a matching component for each kind", async () => {
    const raw = await readFile(DASHBOARD_REGISTRY_PATH, "utf8");
    // Each kind should have an `export { XStep } from "./XStep"` line.
    // The mapping is conventional: "text" → TextStep, "repeat-per" → RepeatPerStep.
    for (const kind of WIZARD_STEP_KINDS) {
      const componentName = `${kind
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("")}Step`;
      expect(
        raw.includes(componentName),
        `expected ${componentName} export in ${DASHBOARD_REGISTRY_PATH}`,
      ).toBe(true);
    }
  });
});
