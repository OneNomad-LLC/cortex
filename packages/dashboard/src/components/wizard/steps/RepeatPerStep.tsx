import { Label } from "@/components/ui/label";
import type { RepeatPerStepShape, WizardStepShape } from "../types";
import { TextStep } from "./TextStep";
import { SelectStep } from "./SelectStep";
import { BooleanStep } from "./BooleanStep";

interface RepeatPerStepProps {
  step: RepeatPerStepShape;
  sourceValue: unknown;
  value: unknown;
  error?: string | undefined;
  onChange: (next: Record<string, Record<string, unknown>>) => void;
}

/**
 * Table-style "for each item in some prior list answer, fill these
 * sub-fields." The most common shape is a single text sub-step with key
 * `__value` (see slack's channelToProject), but we support arbitrary
 * sub-step lists.
 *
 * The data model is `Record<sourceItem, Record<subKey, unknown>>`,
 * matching the slack adapter's wizard state shape exactly so re-runs
 * round-trip cleanly.
 *
 * Only text / select / boolean are accepted as sub-steps. Nested list /
 * record / repeat-per would explode the UI shape and aren't used by
 * any current spec — if a future wizard needs them we add them here.
 */
export function RepeatPerStep(props: RepeatPerStepProps) {
  const { step, sourceValue, value, error, onChange } = props;
  const items = Array.isArray(sourceValue)
    ? (sourceValue as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  const rows =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, Record<string, unknown>>)
      : {};

  const updateCell = (item: string, subKey: string, next: unknown) => {
    const row = rows[item] ?? {};
    onChange({ ...rows, [item]: { ...row, [subKey]: next } });
  };

  if (items.length === 0) {
    return (
      <div className="space-y-2">
        <Label>{step.prompt}</Label>
        <p className="text-xs text-muted-foreground">
          Fill in the &ldquo;{step.source}&rdquo; step above first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label>{step.prompt}</Label>
      {step.description ? (
        <p className="text-xs text-muted-foreground">{step.description}</p>
      ) : null}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">{step.source}</th>
              {step.sub.map((sub) => (
                <th key={sub.key} className="px-3 py-2 font-medium">
                  {sub.prompt}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{item}</td>
                {step.sub.map((sub) => (
                  <td key={sub.key} className="px-3 py-2">
                    <SubCell
                      sub={sub}
                      value={rows[item]?.[sub.key]}
                      onChange={(next) => updateCell(item, sub.key, next)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function SubCell(props: {
  sub: WizardStepShape;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const { sub, value, onChange } = props;
  // Render sub-steps in-place using the same primitive components. We
  // strip the outer label since the column header already shows the
  // prompt, and don't pass errors through — repeat-per validation is
  // surfaced at the parent step level.
  const stripped = { ...sub, prompt: "", description: undefined };
  if (sub.type === "text" || sub.type === "password") {
    return (
      <TextStep
        step={{ ...stripped, type: "text" } as never}
        value={value}
        onChange={(next) => onChange(next)}
      />
    );
  }
  if (sub.type === "select") {
    return (
      <SelectStep
        step={stripped as never}
        value={value}
        onChange={(next) => onChange(next)}
      />
    );
  }
  if (sub.type === "boolean") {
    return (
      <BooleanStep
        step={stripped as never}
        value={value}
        onChange={(next) => onChange(next)}
      />
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      Unsupported sub-step: {sub.type}
    </span>
  );
}
