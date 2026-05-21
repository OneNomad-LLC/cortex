import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { X } from "lucide-react";
import type { ListStepShape } from "../types";
import { regexFromSerialized } from "../types";

interface ListStepProps {
  step: ListStepShape;
  value: unknown;
  error?: string | undefined;
  onChange: (next: string[]) => void;
}

const DEFAULT_SPLITTER = /[\s,]+/;

/**
 * Comma-or-newline-separated free-text input → array of strings, plus a
 * chip view of the current list. Useful for things like Slack channel
 * IDs or Confluence space keys. Editing a chip removes it; remaining
 * edits happen by typing in the textarea then clicking "Apply" to
 * normalize-and-parse.
 *
 * We keep the textarea as the source of truth for the raw text the user
 * is composing, and the array only updates on `Apply`. Otherwise every
 * keystroke would reshuffle the chips, which feels bad.
 */
export function ListStep(props: ListStepProps) {
  const { step, value, error, onChange } = props;
  const splitter = useMemo(
    () => regexFromSerialized(step.splitter) ?? DEFAULT_SPLITTER,
    [step.splitter],
  );
  const items = Array.isArray(value)
    ? (value as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  const parseInput = (raw: string): string[] => {
    return raw
      .split(splitter)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };

  const dropAt = (idx: number) => {
    const next = [...items];
    next.splice(idx, 1);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={step.key}>
        {step.prompt}
        {step.required ? <span className="ml-1 text-destructive">*</span> : null}
      </Label>
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 ? (
          <span className="text-xs text-muted-foreground">No items yet.</span>
        ) : (
          items.map((item, idx) => (
            <Badge
              key={`${item}-${idx}`}
              variant="secondary"
              className="flex items-center gap-1"
            >
              {item}
              <button
                type="button"
                aria-label={`Remove ${item}`}
                onClick={() => dropAt(idx)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))
        )}
      </div>
      <Textarea
        id={step.key}
        placeholder="Paste comma-or-newline-separated values, then click Apply…"
        rows={2}
        onKeyDown={(e) => {
          if ((e.key === "Enter" && (e.metaKey || e.ctrlKey)) || e.key === "Tab") {
            e.preventDefault();
            const next = parseInput((e.currentTarget.value ?? "").trim());
            if (next.length > 0) {
              onChange([...items, ...next]);
              e.currentTarget.value = "";
            }
          }
        }}
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={(e) => {
            const ta = (e.currentTarget.parentElement?.previousElementSibling ??
              null) as HTMLTextAreaElement | null;
            if (!ta) return;
            const next = parseInput(ta.value.trim());
            if (next.length === 0) return;
            onChange([...items, ...next]);
            ta.value = "";
          }}
        >
          Apply
        </Button>
      </div>
      {step.description ? (
        <p className="text-xs text-muted-foreground">{step.description}</p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
