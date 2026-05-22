/**
 * Central registry of step kind → component. The CI guardrail in the
 * server package imports the keys of this map and asserts they cover
 * the `WizardStepKind` union from cortex-core — adding a new step kind
 * in core without adding a renderer here breaks the build.
 */

import type { WizardStepKind } from "../types";

export const STEP_COMPONENT_KINDS: ReadonlyArray<WizardStepKind> = [
  "text",
  "password",
  "boolean",
  "select",
  "list",
  "repeat-per",
  "record",
] as const;

export { TextStep } from "./TextStep";
export { PasswordStep } from "./PasswordStep";
export { BooleanStep } from "./BooleanStep";
export { SelectStep } from "./SelectStep";
export { ListStep } from "./ListStep";
export { RepeatPerStep } from "./RepeatPerStep";
export { RecordStep } from "./RecordStep";
