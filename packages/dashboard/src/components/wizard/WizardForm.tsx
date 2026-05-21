import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type {
  WizardSpec,
  WizardStepShape,
  WizardSecretShape,
} from "./types";
import { regexFromSerialized } from "./types";
import { evaluateWhen } from "./when";
import {
  TextStep,
  PasswordStep,
  BooleanStep,
  SelectStep,
  ListStep,
  RepeatPerStep,
  RecordStep,
} from "./steps";

export interface WizardFormProps {
  /** Full spec from `GET /api/dashboard/wizard/spec/:kind/:id`. */
  spec: WizardSpec;
  /**
   * Initial values keyed by step `key` AND by secret `envVar`. The
   * server fills password fields with the literal `__REDACTED__`
   * sentinel for already-configured secrets; the `PasswordStep`
   * component renders that as a "click to replace" affordance.
   */
  initialValues?: Record<string, unknown>;
  /**
   * Called when the user submits and client-side validation passes.
   * Throw / reject from this callback to surface server-side errors:
   * use the shape `{ errors: Record<stepKey, message> }` and the form
   * will display them inline.
   */
  onSubmit: (
    answers: Record<string, unknown>,
  ) => Promise<void | { errors?: Record<string, string> }>;
  /** Submit button label override — defaults to "Save". */
  submitLabel?: string;
  /** Render a Cancel button alongside Submit. */
  onCancel?: () => void;
}

/**
 * WizardForm — renders a `WizardModule` spec as a stack of step
 * components and surfaces a normalized `answers` object on submit.
 *
 * State model: a flat `answers` object keyed by step `key` (and by
 * secret `envVar` for secret rows). The shape mirrors what the server
 * accepts at `POST /api/dashboard/wizard/run`. We don't use
 * react-hook-form's `useForm` here because the step shape is dynamic
 * and the renderer benefits more from controlled-input granularity
 * than RHF's uncontrolled refs.
 *
 * Validation:
 *   - Inline: required steps must be non-empty; text steps with a
 *     `pattern` regex are checked against it.
 *   - Server-side: the authoritative validation is the wizard's own Zod
 *     schema in the server. Errors come back keyed by `path.join(".")`
 *     and we attach them to the matching step.
 *
 * Conditional visibility:
 *   Each step may carry a `when` predicate (see ./when.ts). Hidden steps
 *   are removed from the submitted answers so a transient toggle
 *   doesn't leak stale values into the saved config.
 */
export function WizardForm(props: WizardFormProps) {
  const { spec, initialValues, onSubmit, submitLabel, onCancel } = props;
  const [answers, setAnswers] = useState<Record<string, unknown>>(() =>
    seedAnswers(spec, initialValues),
  );
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | undefined>(undefined);

  const visibleSteps = useMemo(
    () => spec.steps.filter((s) => evaluateWhen(s.when, answers)),
    [spec.steps, answers],
  );

  const setAnswer = (key: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const runInlineValidation = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const step of visibleSteps) {
      if (step.required) {
        if (isEmpty(answers[step.key])) {
          out[step.key] = "Required";
          continue;
        }
      }
      if (step.type === "text") {
        const rx = regexFromSerialized(step.pattern);
        const v = answers[step.key];
        if (rx && typeof v === "string" && v.length > 0 && !rx.test(v)) {
          out[step.key] = step.patternHint ?? `Must match ${rx.source}`;
        }
      }
    }
    for (const secret of spec.secrets) {
      if (secret.required) {
        const v = answers[secret.envVar];
        // `__REDACTED__` counts as "already configured" — required
        // satisfied, just don't overwrite.
        if (isEmpty(v)) {
          out[secret.envVar] = "Required";
        }
      }
    }
    return out;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const inline = runInlineValidation();
    if (Object.keys(inline).length > 0) {
      setErrors(inline);
      setTopError("Fix the highlighted fields and try again.");
      return;
    }
    setErrors({});
    setTopError(undefined);
    setSubmitting(true);
    try {
      // Strip answers for hidden steps so a toggle-and-toggle-back
      // doesn't carry stale state. Secrets always pass through.
      const visibleKeys = new Set(visibleSteps.map((s) => s.key));
      const payload: Record<string, unknown> = {};
      for (const step of spec.steps) {
        if (visibleKeys.has(step.key)) {
          payload[step.key] = answers[step.key];
        }
      }
      for (const secret of spec.secrets) {
        if (secret.envVar in answers) {
          payload[secret.envVar] = answers[secret.envVar];
        }
      }
      const result = await onSubmit(payload);
      if (result && result.errors && Object.keys(result.errors).length > 0) {
        setErrors(result.errors);
        setTopError("Server rejected the submission.");
      }
    } catch (err) {
      setTopError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const inlineInvalid = Object.keys(runInlineValidation()).length > 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Card>
        <CardContent className="space-y-5 p-5">
          {visibleSteps.map((step) => (
            <StepRenderer
              key={step.key}
              step={step}
              answers={answers}
              error={errors[step.key]}
              setAnswer={setAnswer}
            />
          ))}
          {spec.secrets.length > 0 ? (
            <div className="space-y-5 border-t pt-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Secrets
              </p>
              {spec.secrets.map((secret) => (
                <SecretRenderer
                  key={secret.envVar}
                  secret={secret}
                  value={answers[secret.envVar]}
                  error={errors[secret.envVar]}
                  setAnswer={setAnswer}
                />
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
      {topError ? (
        <p className="text-sm text-destructive">{topError}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={submitting || inlineInvalid}>
          {submitting ? "Saving…" : (submitLabel ?? "Save")}
        </Button>
      </div>
    </form>
  );
}

function StepRenderer(props: {
  step: WizardStepShape;
  answers: Record<string, unknown>;
  error?: string | undefined;
  setAnswer: (key: string, value: unknown) => void;
}) {
  const { step, answers, error, setAnswer } = props;
  const value = answers[step.key];

  switch (step.type) {
    case "text":
      return (
        <TextStep
          step={step}
          value={value}
          error={error}
          onChange={(next) => setAnswer(step.key, next)}
        />
      );
    case "password":
      return (
        <PasswordStep
          step={step}
          value={value}
          error={error}
          onChange={(next) => setAnswer(step.key, next)}
        />
      );
    case "boolean":
      return (
        <BooleanStep
          step={step}
          value={value}
          error={error}
          onChange={(next) => setAnswer(step.key, next)}
        />
      );
    case "select":
      return (
        <SelectStep
          step={step}
          value={value}
          error={error}
          onChange={(next) => setAnswer(step.key, next)}
        />
      );
    case "list":
      return (
        <ListStep
          step={step}
          value={value}
          error={error}
          onChange={(next) => setAnswer(step.key, next)}
        />
      );
    case "repeat-per":
      return (
        <RepeatPerStep
          step={step}
          sourceValue={answers[step.source]}
          value={value}
          error={error}
          onChange={(next) => setAnswer(step.key, next)}
        />
      );
    case "record":
      return (
        <RecordStep
          step={step}
          value={value}
          error={error}
          onChange={(next) => setAnswer(step.key, next)}
        />
      );
    default: {
      // Render-time exhaustiveness check — TS catches missing kinds at
      // compile time; this runtime branch keeps a forward-compat exit
      // for specs delivered from a newer server.
      return (
        <p className="text-xs text-destructive">
          Unsupported step kind: {(step as { type: string }).type}
        </p>
      );
    }
  }
}

function SecretRenderer(props: {
  secret: WizardSecretShape;
  value: unknown;
  error?: string | undefined;
  setAnswer: (key: string, value: unknown) => void;
}) {
  const { secret, value, error, setAnswer } = props;
  // Reuse the password / text step components — a wizard "secret" is
  // just a step that lives in the `.env` rather than the YAML config.
  if (secret.type === "password") {
    return (
      <PasswordStep
        step={{
          type: "password",
          key: secret.envVar,
          prompt: secret.prompt,
          required: secret.required ?? false,
        }}
        value={value}
        error={error}
        onChange={(next) => setAnswer(secret.envVar, next)}
      />
    );
  }
  return (
    <TextStep
      step={{
        type: "text",
        key: secret.envVar,
        prompt: secret.prompt,
        required: secret.required ?? false,
      }}
      value={value}
      error={error}
      onChange={(next) => setAnswer(secret.envVar, next)}
    />
  );
}

function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object")
    return Object.keys(value as object).length === 0;
  return false;
}

/**
 * Seed answers from the spec defaults + caller-provided initial values.
 * Caller values win — they represent the saved config in edit mode and
 * should override the default.
 */
function seedAnswers(
  spec: WizardSpec,
  initialValues: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const step of spec.steps) {
    if (step.defaultValue !== undefined) out[step.key] = step.defaultValue;
  }
  if (initialValues) {
    for (const [k, v] of Object.entries(initialValues)) out[k] = v;
  }
  return out;
}
