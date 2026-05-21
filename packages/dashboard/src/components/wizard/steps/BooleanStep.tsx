import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { BooleanStepShape } from "../types";

interface BooleanStepProps {
  step: BooleanStepShape;
  value: unknown;
  error?: string | undefined;
  onChange: (next: boolean) => void;
}

/**
 * Boolean toggle. Defaults to `false` when the answer isn't set yet;
 * spec authors who want a `true` default should set `defaultValue: true`
 * on the step and rely on the form's initialValues to seed it.
 */
export function BooleanStep(props: BooleanStepProps) {
  const { step, value, error, onChange } = props;
  const boolValue = value === true;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-md border bg-card p-3">
        <div className="flex flex-col">
          <Label htmlFor={step.key} className="cursor-pointer">
            {step.prompt}
            {step.required ? (
              <span className="ml-1 text-destructive">*</span>
            ) : null}
          </Label>
          {step.description ? (
            <p className="text-xs text-muted-foreground">{step.description}</p>
          ) : null}
        </div>
        <Switch
          id={step.key}
          checked={boolValue}
          onCheckedChange={(next) => onChange(next)}
        />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
