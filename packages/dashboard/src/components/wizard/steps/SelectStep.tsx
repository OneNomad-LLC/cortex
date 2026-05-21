import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SelectStepShape } from "../types";

interface SelectStepProps {
  step: SelectStepShape;
  value: unknown;
  error?: string | undefined;
  onChange: (next: string) => void;
}

/**
 * Single-choice select. Renders the spec's `choices` straight through to
 * Radix's `SelectContent`. Descriptions per option appear as secondary
 * text under the label inside the menu so the user has a hint without
 * leaving the dropdown.
 */
export function SelectStep(props: SelectStepProps) {
  const { step, value, error, onChange } = props;
  const stringValue = typeof value === "string" ? value : "";

  return (
    <div className="space-y-2">
      <Label htmlFor={step.key}>
        {step.prompt}
        {step.required ? <span className="ml-1 text-destructive">*</span> : null}
      </Label>
      <Select
        {...(stringValue ? { value: stringValue } : {})}
        onValueChange={(next) => onChange(next)}
      >
        <SelectTrigger id={step.key} aria-invalid={Boolean(error) || undefined}>
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {step.choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              <div className="flex flex-col">
                <span>{choice.label}</span>
                {choice.description ? (
                  <span className="text-xs text-muted-foreground">
                    {choice.description}
                  </span>
                ) : null}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {step.description ? (
        <p className="text-xs text-muted-foreground">{step.description}</p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
