import type { z } from "zod";

/**
 * Declarative, framework-agnostic module setup spec.
 *
 * Adapters, LLM providers, memory backends, and toolkits export a
 * `WizardModule` alongside their Zod config schema. Two renderers consume
 * the same spec:
 *   - CLI runner (`cortex init`, `cortex add`, `cortex configure`) —
 *     walks steps via @inquirer/prompts, writes to `cortex.local.yaml`
 *     + `.env` + `projects.local.yaml`.
 *   - Dashboard module catalog — renders the same steps as a React form
 *     and posts to a server action that calls the same config-mutation
 *     service as the CLI.
 *
 * Keep the spec free of framework-specific types (no React, no inquirer).
 * Validation happens against the module's Zod schema after collection,
 * not inline — simpler renderers, one source of truth for config shape.
 */
export interface WizardModule<TConfig = unknown> {
  /** Module id — matches adapter/provider/toolkit id. */
  readonly id: string;
  /** Human name shown in prompts and the catalog. */
  readonly name: string;
  /** Category shown in the dashboard module catalog. */
  readonly category: "adapter" | "provider" | "memory" | "toolkit" | "webhook";
  /** One-line description of what the module does. */
  readonly description: string;
  /** Steps for gathering config values. Evaluated in order. */
  readonly steps: readonly WizardStep[];
  /** Secret env vars this module needs. Written to `.env`. */
  readonly secrets?: readonly WizardSecret[];
  /**
   * Zod schema the collected config must satisfy after all steps.
   * Usually the module's existing `configSchema`. `ZodTypeAny` to tolerate
   * schemas with `.default()` / `.preprocess()` wrappers whose input and
   * output diverge; runtime parsing still enforces the concrete TConfig.
   */
  readonly configSchema: z.ZodTypeAny;
  /**
   * Optional hook: extract taxonomy entries (new projects, new people,
   * new engagements) that should be appended to the corresponding
   * `*.local.yaml` files. The runner gets confirmation before writing.
   */
  readonly derivedTaxonomy?: (state: Record<string, unknown>) => DerivedTaxonomy;
}

/**
 * Step shapes. New kinds can be added; each renderer branches on `type`.
 * Unknown types should fall through to the next step with a warning.
 */
export type WizardStep =
  | TextStep
  | PasswordStep
  | BooleanStep
  | SelectStep
  | ListStep
  | RepeatPerStep
  | RecordStep;

/**
 * Canonical list of step `type` discriminators. Mirrors the union above
 * but as a runtime value so guardrail tests can iterate it. The CI
 * completeness check in `tests/wizard-renderer-completeness.test.ts`
 * asserts every kind here has a renderer component in the dashboard
 * package. Adding a new kind to `WizardStep`? Add the literal here too.
 */
export const WIZARD_STEP_KINDS = [
  "text",
  "password",
  "boolean",
  "select",
  "list",
  "repeat-per",
  "record",
] as const;

export type WizardStepKind = (typeof WIZARD_STEP_KINDS)[number];

interface BaseStep {
  key: string;
  prompt: string;
  description?: string;
  required?: boolean;
  /** Default shown to the user; may be overridden by `currentValue` in configure-mode. */
  defaultValue?: unknown;
}

export interface TextStep extends BaseStep {
  type: "text";
  placeholder?: string;
  /** Optional regex validator applied before Zod — for clearer error prompts. */
  pattern?: RegExp;
  patternHint?: string;
}

export interface PasswordStep extends BaseStep {
  type: "password";
}

export interface BooleanStep extends BaseStep {
  type: "boolean";
}

export interface SelectStep extends BaseStep {
  type: "select";
  choices: readonly { value: string; label: string; description?: string }[];
}

export interface ListStep extends BaseStep {
  type: "list";
  /** Splitter for comma / newline input. Default is /[\s,]+/. */
  splitter?: RegExp;
  /** Optional per-item validator (regex). */
  itemPattern?: RegExp;
}

/**
 * For each entry in `source` (a key earlier in the spec that produced a
 * string array), run the `sub` steps scoped under that entry. Produces a
 * `Record<string, SubAnswers>` keyed by the source entry.
 */
export interface RepeatPerStep extends BaseStep {
  type: "repeat-per";
  source: string;
  sub: readonly WizardStep[];
}

/**
 * Map-style: key/value pairs entered until the user signals "done."
 * Used for mappings like `spaceToProject` when `spaceToContext` isn't
 * rich enough.
 */
export interface RecordStep extends BaseStep {
  type: "record";
  keyPrompt: string;
  valuePrompt: string;
}

export interface WizardSecret {
  envVar: string;
  prompt: string;
  type: "text" | "password";
  required?: boolean;
}

export interface DerivedTaxonomy {
  projects?: readonly {
    slug: string;
    name?: string;
    description?: string;
    /**
     * Source hints to persist under `projects.yaml.sources`. Emitted by
     * the projects wizard when a project was discovered through an
     * adapter (e.g. `{ google_calendar_id: "..." }`). Merged into any
     * existing `sources` block; user-curated fields are never overwritten.
     */
    sources?: Record<string, unknown>;
  }[];
  people?: readonly { slug: string; name?: string; email?: string }[];
  engagements?: readonly { slug: string; name?: string }[];
}

/**
 * What a completed wizard run produces. Consumed by the config-mutation
 * service — either via the CLI runner or a dashboard server action.
 */
export interface WizardResult<TConfig = unknown> {
  moduleId: string;
  /**
   * Which section of `cortex.local.yaml` this result lands in. Required
   * for the config-mutation service to route correctly: adapters live
   * under `adapters.<id>`, providers under `llm.providers.<id>`, memory
   * under `memory.<id>`, webhooks merged into the `webhooks` block.
   * Defaults to "adapter" for back-compat with earlier wizards.
   */
  category?: WizardModule["category"];
  config: TConfig;
  secrets: Record<string, string>;
  derivedTaxonomy?: DerivedTaxonomy;
}
