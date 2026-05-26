import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PasswordStepShape } from "../types";
import { REDACTED_SENTINEL } from "../types";

interface PasswordStepProps {
  step: PasswordStepShape;
  value: unknown;
  error?: string | undefined;
  onChange: (next: string) => void;
}

/**
 * Password / secret field. Two modes:
 *
 *   1. Fresh / replacing — render a `<input type="password">`. The user
 *      types the new value; submitting the form sends it up.
 *
 *   2. Edit mode where the server returned the `__REDACTED__` sentinel —
 *      we DO NOT repopulate the hash. Show a "[Redacted — click to
 *      replace]" button. Clicking switches to mode 1 with an empty
 *      input. Leaving the input untouched means the value stays
 *      `__REDACTED__` and the server treats it as a no-op (preserving
 *      whatever's on disk).
 *
 * Never log the value, never round-trip it through any debug printer.
 */
export function PasswordStep(props: PasswordStepProps) {
  const { step, value, error, onChange } = props;
  const stringValue = typeof value === "string" ? value : "";
  const isRedacted = stringValue === REDACTED_SENTINEL;
  const [revealed, setRevealed] = useState(false);

  if (isRedacted && !revealed) {
    return (
      <div className="space-y-2">
        <Label htmlFor={step.key}>
          {step.prompt}
          {step.required ? (
            <span className="ml-1 text-destructive">*</span>
          ) : null}
        </Label>
        <div className="flex items-center gap-2">
          <span className="rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
            ••••••••
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onChange("");
              setRevealed(true);
            }}
          >
            Replace
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Redacted — click to replace
        </p>
        {step.description ? (
          <p className="text-xs text-muted-foreground">{step.description}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={step.key}>
        {step.prompt}
        {step.required ? <span className="ml-1 text-destructive">*</span> : null}
      </Label>
      <Input
        id={step.key}
        type="password"
        value={stringValue}
        autoComplete="new-password"
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error) || undefined}
      />
      {step.description ? (
        <p className="text-xs text-muted-foreground">{step.description}</p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
