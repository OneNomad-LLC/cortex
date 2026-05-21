import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TextStepShape } from "../types";
import { regexFromSerialized } from "../types";

interface TextStepProps {
  step: TextStepShape;
  value: unknown;
  error?: string | undefined;
  onChange: (next: string) => void;
}

/**
 * Single-line text. Pattern hint shown under the field when set. Final
 * validation lives in the parent's Zod schema — the hint is purely a
 * UX nicety, not a guard.
 */
export function TextStep(props: TextStepProps) {
  const { step, value, error, onChange } = props;
  const pattern = regexFromSerialized(step.pattern);
  const stringValue = typeof value === "string" ? value : "";

  return (
    <div className="space-y-2">
      <Label htmlFor={step.key}>
        {step.prompt}
        {step.required ? <span className="ml-1 text-destructive">*</span> : null}
      </Label>
      <Input
        id={step.key}
        value={stringValue}
        placeholder={step.placeholder ?? ""}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error) || undefined}
      />
      {step.description ? (
        <p className="text-xs text-muted-foreground">{step.description}</p>
      ) : null}
      {step.patternHint && pattern ? (
        <p className="text-xs text-muted-foreground">
          Format: {step.patternHint}
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
