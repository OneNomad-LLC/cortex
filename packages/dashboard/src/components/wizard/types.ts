/**
 * Dashboard-side mirror of the wizard spec shape. The server serializes
 * its `WizardModule` (from `@onenomad/przm-cortex-core`) into JSON,
 * dropping the Zod `configSchema` and translating any `RegExp` fields
 * into `{ source, flags }` records. This module declares the shape the
 * SPA actually receives over the wire.
 *
 * Kept separate from the core package so the dashboard build doesn't
 * have to pull in the entire core monorepo via tsconfig path mapping.
 */

import type { WhenPredicate } from "./when";

export type WizardStepKind =
  | "text"
  | "password"
  | "boolean"
  | "select"
  | "list"
  | "repeat-per"
  | "record";

export interface SerializedRegExp {
  source: string;
  flags: string;
}

interface BaseStepShape {
  key: string;
  prompt: string;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
  /** Optional visibility predicate. See `./when.ts`. */
  when?: WhenPredicate;
}

export interface TextStepShape extends BaseStepShape {
  type: "text";
  placeholder?: string;
  pattern?: SerializedRegExp;
  patternHint?: string;
}

export interface PasswordStepShape extends BaseStepShape {
  type: "password";
}

export interface BooleanStepShape extends BaseStepShape {
  type: "boolean";
}

export interface SelectStepShape extends BaseStepShape {
  type: "select";
  choices: ReadonlyArray<{
    value: string;
    label: string;
    description?: string;
  }>;
}

export interface ListStepShape extends BaseStepShape {
  type: "list";
  splitter?: SerializedRegExp;
  itemPattern?: SerializedRegExp;
}

export interface RepeatPerStepShape extends BaseStepShape {
  type: "repeat-per";
  source: string;
  sub: ReadonlyArray<WizardStepShape>;
}

export interface RecordStepShape extends BaseStepShape {
  type: "record";
  keyPrompt: string;
  valuePrompt: string;
}

export type WizardStepShape =
  | TextStepShape
  | PasswordStepShape
  | BooleanStepShape
  | SelectStepShape
  | ListStepShape
  | RepeatPerStepShape
  | RecordStepShape;

export interface WizardSecretShape {
  envVar: string;
  prompt: string;
  type: "text" | "password";
  required?: boolean;
}

export interface WizardSpec {
  id: string;
  kind: "adapter" | "provider" | "memory" | "toolkit" | "webhook";
  name: string;
  description: string;
  steps: ReadonlyArray<WizardStepShape>;
  secrets: ReadonlyArray<WizardSecretShape>;
}

export const REDACTED_SENTINEL = "__REDACTED__";

/**
 * Reconstitute a RegExp from the server-serialized `{ source, flags }`
 * pair. Returns `undefined` on malformed input — the caller treats that
 * as "no pattern" rather than blowing up.
 */
export function regexFromSerialized(
  rx: SerializedRegExp | undefined,
): RegExp | undefined {
  if (!rx || typeof rx.source !== "string") return undefined;
  try {
    return new RegExp(rx.source, rx.flags ?? "");
  } catch {
    return undefined;
  }
}
