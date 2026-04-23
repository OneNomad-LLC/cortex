"use client";

import { useEffect, useState } from "react";

/**
 * Dashboard twin of the CLI wizard runner. Takes a WizardModule id,
 * fetches the spec from the sidecar, renders each step as the right
 * HTML input, and POSTs a `WizardResult`-shaped payload on submit.
 *
 * Step type coverage matches the CLI runner — text, password,
 * boolean, select, list. `repeat-per` and `record` fall back to a
 * raw JSON textarea (power users can still submit; v2 gets proper
 * widgets).
 */

export interface WizardStep {
  key: string;
  type:
    | "text"
    | "password"
    | "boolean"
    | "select"
    | "list"
    | "repeat-per"
    | "record";
  prompt: string;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
  placeholder?: string;
  choices?: Array<{ value: string; label: string; description?: string }>;
  source?: string;
}

export interface WizardSecret {
  envVar: string;
  prompt: string;
  type: "text" | "password";
  required?: boolean;
}

export interface WizardSpec {
  id: string;
  name: string;
  category: string;
  description: string;
  steps: WizardStep[];
  secrets: WizardSecret[];
}

export interface WizardSubmitResult {
  applied: boolean;
  filesWritten: string[];
  warning?: string;
}

export function WizardForm({
  wizardId,
  onSuccess,
}: {
  wizardId: string;
  onSuccess?: (result: WizardSubmitResult) => void;
}): React.JSX.Element {
  const [spec, setSpec] = useState<WizardSpec | undefined>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<WizardSubmitResult | undefined>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(undefined);
      try {
        const res = await fetch(`/api/cortex/wizards/${wizardId}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as WizardSpec;
        if (cancelled) return;
        setSpec(body);
        // Seed defaults so untouched fields submit correctly.
        const seeds: Record<string, unknown> = {};
        for (const step of body.steps) {
          if (step.defaultValue !== undefined) seeds[step.key] = step.defaultValue;
        }
        setValues(seeds);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wizardId]);

  async function submit(): Promise<void> {
    if (!spec) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/cortex/wizards/${spec.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: values, secrets }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          issues?: Array<{ path: string[]; message: string }>;
        };
        const issueMsg = body.issues
          ?.map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new Error(body.error ?? issueMsg ?? `${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as WizardSubmitResult;
      setResult(body);
      onSuccess?.(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading wizard…</p>;
  if (error && !spec) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        Couldn&apos;t load wizard: {error}
      </p>
    );
  }
  if (!spec) return <p className="text-sm text-neutral-500">Missing wizard spec.</p>;

  if (result) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
        <p className="font-medium">Saved {spec.name}.</p>
        <p className="mt-1">
          Wrote to {result.filesWritten.length} file
          {result.filesWritten.length === 1 ? "" : "s"}.
        </p>
        {result.warning && (
          <p className="mt-2 text-xs text-emerald-800 dark:text-emerald-300">
            {result.warning}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <header>
        <h3 className="text-base font-semibold">{spec.name}</h3>
        {spec.description && (
          <p className="mt-0.5 text-sm text-neutral-500">{spec.description}</p>
        )}
      </header>

      {spec.steps.map((step) => (
        <FieldForStep
          key={step.key}
          step={step}
          value={values[step.key]}
          onChange={(v) =>
            setValues((prev) => ({
              ...prev,
              [step.key]: v,
            }))
          }
        />
      ))}

      {spec.secrets.length > 0 && (
        <fieldset className="space-y-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900/50">
          <legend className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Secrets
          </legend>
          {spec.secrets.map((sec) => (
            <SecretField
              key={sec.envVar}
              secret={sec}
              value={secrets[sec.envVar] ?? ""}
              onChange={(v) =>
                setSecrets((prev) => ({ ...prev, [sec.envVar]: v }))
              }
            />
          ))}
          <p className="text-[11px] text-neutral-500">
            Secrets are written to the active workspace&apos;s{" "}
            <code className="font-mono">.env</code> and never committed.
          </p>
        </fieldset>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
      >
        {submitting ? "Saving…" : `Save ${spec.name}`}
      </button>
    </form>
  );
}

function FieldForStep({
  step,
  value,
  onChange,
}: {
  step: WizardStep;
  value: unknown;
  onChange: (v: unknown) => void;
}): React.JSX.Element {
  const label = (
    <label className="mb-1 block text-sm font-medium">
      {step.prompt}
      {step.required && <span className="ml-1 text-red-600">*</span>}
    </label>
  );
  const hint = step.description ? (
    <p className="mt-1 text-xs text-neutral-500">{step.description}</p>
  ) : null;

  switch (step.type) {
    case "text":
    case "password":
      return (
        <div>
          {label}
          <input
            type={step.type === "password" ? "password" : "text"}
            value={typeof value === "string" ? value : ""}
            placeholder={step.placeholder}
            onChange={(e) => onChange(e.target.value)}
            className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm dark:border-neutral-800 dark:bg-neutral-900"
          />
          {hint}
        </div>
      );
    case "boolean":
      return (
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value === true}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span className="font-medium">{step.prompt}</span>
            {step.required && <span className="text-red-600">*</span>}
          </label>
          {hint}
        </div>
      );
    case "select":
      return (
        <div>
          {label}
          <select
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
            <option value="">— select —</option>
            {step.choices?.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {hint}
        </div>
      );
    case "list":
      return (
        <div>
          {label}
          <input
            type="text"
            value={
              Array.isArray(value)
                ? (value as string[]).join(", ")
                : typeof value === "string"
                  ? value
                  : ""
            }
            placeholder={step.placeholder ?? "comma-separated"}
            onChange={(e) =>
              onChange(
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              )
            }
            className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm dark:border-neutral-800 dark:bg-neutral-900"
          />
          {hint}
        </div>
      );
    default:
      return (
        <div>
          {label}
          <textarea
            value={typeof value === "string" ? value : JSON.stringify(value ?? "")}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {
                onChange(e.target.value);
              }
            }}
            rows={4}
            className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-900"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Advanced step (type: {step.type}). Enter JSON.
          </p>
        </div>
      );
  }
}

function SecretField({
  secret,
  value,
  onChange,
}: {
  secret: WizardSecret;
  value: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">
        {secret.prompt}
        {secret.required && <span className="ml-1 text-red-600">*</span>}
      </label>
      <input
        type={secret.type === "password" ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      />
      <p className="mt-1 text-[11px] text-neutral-500">
        env var: <code className="font-mono">{secret.envVar}</code>
      </p>
    </div>
  );
}
