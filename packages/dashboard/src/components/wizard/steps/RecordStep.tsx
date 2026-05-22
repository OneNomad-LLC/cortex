import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, Plus } from "lucide-react";
import type { RecordStepShape } from "../types";

interface RecordStepProps {
  step: RecordStepShape;
  value: unknown;
  error?: string | undefined;
  onChange: (next: Record<string, string>) => void;
}

/**
 * Free-form key/value-pair editor. Used by spec authors when the mapping
 * isn't between a known list and a fixed sub-shape — e.g. label → color
 * pairs that the user freely defines.
 *
 * Stored as `Record<string, string>` over the wire; we keep an empty
 * trailing row in the local view for the "add another" affordance. The
 * trailing empty row is pruned out of `onChange`.
 */
export function RecordStep(props: RecordStepProps) {
  const { step, value, error, onChange } = props;
  const map =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};
  const rows = Object.entries(map);

  const pushRow = () => onChange({ ...map, "": "" });

  const renameKey = (oldKey: string, newKey: string) => {
    if (oldKey === newKey) return;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  };

  const updateValue = (k: string, v: string) => onChange({ ...map, [k]: v });

  const dropRow = (k: string) => {
    const next = { ...map };
    delete next[k];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <Label>
        {step.prompt}
        {step.required ? <span className="ml-1 text-destructive">*</span> : null}
      </Label>
      {step.description ? (
        <p className="text-xs text-muted-foreground">{step.description}</p>
      ) : null}
      <div className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No entries yet.</p>
        ) : (
          rows.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <Input
                value={k}
                placeholder={step.keyPrompt}
                onChange={(e) => renameKey(k, e.target.value)}
                className="flex-1"
              />
              <Input
                value={v}
                placeholder={step.valuePrompt}
                onChange={(e) => updateValue(k, e.target.value)}
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove row"
                onClick={() => dropRow(k)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={pushRow}>
        <Plus className="mr-1 h-3 w-3" /> Add entry
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
