"use client";

import { useEffect, useState } from "react";
import { GitHubAuthButton } from "./github-auth-button";

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

interface DiscoveryCandidate {
  slug: string;
  name: string;
  description?: string;
  sourceHints?: Record<string, unknown>;
}

interface DiscoveryResult {
  candidates: DiscoveryCandidate[];
  status: "ok" | "no-discovery" | "failed";
  error?: string;
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
  // GitHub-specific: gate the form on device-flow auth and replace
  // the `repos` text field with a multi-select populated by
  // `discoverProjects`.
  const [githubAuthed, setGithubAuthed] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryResult | undefined>();
  const [discovering, setDiscovering] = useState(false);

  const needsGithubAuth = spec?.id === "github" && !githubAuthed;

  useEffect(() => {
    if (spec?.id !== "github") return;
    void (async () => {
      try {
        const r = await fetch("/api/cortex/auth/github/status", {
          cache: "no-store",
        });
        const body = (await r.json()) as { authenticated: boolean };
        setGithubAuthed(body.authenticated === true);
      } catch {
        setGithubAuthed(false);
      }
    })();
  }, [spec?.id]);

  // Once GitHub auth is in place, fetch available repos so the
  // multi-select is pre-populated. We only run it once per auth
  // transition — manual refresh via the button re-triggers.
  useEffect(() => {
    if (spec?.id !== "github" || !githubAuthed || discovery) return;
    void fetchDiscovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec?.id, githubAuthed]);

  async function fetchDiscovery(): Promise<void> {
    if (!spec) return;
    setDiscovering(true);
    try {
      const res = await fetch(
        `/api/cortex/wizards/${spec.id}/discover`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: values, secrets }),
        },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setDiscovery((await res.json()) as DiscoveryResult);
    } catch (e) {
      setDiscovery({
        candidates: [],
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDiscovering(false);
    }
  }

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
      // Split list-step strings into arrays at submit time — the inputs
      // track raw strings during editing so the user can type commas
      // without the controlled-input splitter eating them.
      const payload: Record<string, unknown> = { ...values };
      for (const step of spec.steps) {
        if (step.type !== "list") continue;
        const v = payload[step.key];
        if (typeof v === "string") {
          payload[step.key] = v
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
      }
      const res = await fetch(`/api/cortex/wizards/${spec.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: payload, secrets }),
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

  // GitHub-specific gate: show ONLY the connect step until the user
  // authorizes. After auth, fall through to the full form with a
  // multi-select repo picker.
  if (needsGithubAuth) {
    return (
      <div className="space-y-4">
        <header>
          <h3 className="text-base font-semibold">{spec.name}</h3>
          {spec.description && (
            <p className="mt-0.5 text-sm text-neutral-500">{spec.description}</p>
          )}
        </header>
        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/50">
          <p className="mb-3 text-sm text-neutral-700 dark:text-neutral-200">
            Authorize Cortex via GitHub&apos;s device flow. We&apos;ll
            list your repos once you approve.
          </p>
          <GitHubAuthButton
            onAuthorized={() => {
              setGithubAuthed(true);
              void fetchDiscovery();
            }}
          />
        </div>
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

      {spec.id === "github" && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/30">
          <GitHubAuthButton size="compact" />
        </div>
      )}

      {spec.steps.map((step) => {
        // GitHub: swap the `repos` list field for a discovery-backed
        // multi-select so the user picks from an actual list of their
        // repos instead of typing owner/repo by hand.
        if (spec.id === "github" && step.key === "repos" && step.type === "list") {
          return (
            <GithubReposPicker
              key={step.key}
              step={step}
              value={values[step.key]}
              onChange={(v) =>
                setValues((prev) => ({ ...prev, [step.key]: v }))
              }
              discovery={discovery}
              discovering={discovering}
              onRefresh={() => void fetchDiscovery()}
            />
          );
        }
        return (
          <FieldForStep
            key={step.key}
            step={step}
            value={values[step.key]}
            onChange={(v) =>
              setValues((prev) => ({ ...prev, [step.key]: v }))
            }
          />
        );
      })}

      {spec.id !== "github" && spec.secrets.length > 0 && (
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
      // Store the raw string during editing — don't split on each
      // keystroke. Splitting + filtering empty segments during typing
      // drops the user's trailing comma before it renders, which makes
      // the comma key appear to do nothing. Submit-time transform
      // converts the string into a string[] for the server.
      return (
        <div>
          {label}
          <input
            type="text"
            value={
              typeof value === "string"
                ? value
                : Array.isArray(value)
                  ? (value as string[]).join(", ")
                  : ""
            }
            placeholder={step.placeholder ?? "comma-separated"}
            onChange={(e) => onChange(e.target.value)}
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

/**
 * Multi-select dropdown for GitHub repos. Populated by
 * `discoverProjects` → `sourceHints.github_repos[0]`. Users can:
 *   - Select individual repos (checkboxes)
 *   - "Select all"
 *   - Refresh the list if they created repos since opening
 *   - Fall back to typing when discovery fails
 *
 * Value stays as a comma-separated string internally (same shape as
 * other list-type fields) so submit-time array splitting still works
 * without a branch.
 */
function GithubReposPicker({
  step,
  value,
  onChange,
  discovery,
  discovering,
  onRefresh,
}: {
  step: WizardStep;
  value: unknown;
  onChange: (v: unknown) => void;
  discovery: DiscoveryResult | undefined;
  discovering: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  const current = typeof value === "string"
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : Array.isArray(value)
      ? (value as string[])
      : [];
  const selected = new Set(current);

  function toggle(fullName: string): void {
    const next = new Set(selected);
    if (next.has(fullName)) next.delete(fullName);
    else next.add(fullName);
    onChange(Array.from(next).join(", "));
  }

  function selectAll(): void {
    if (!discovery) return;
    const all = discovery.candidates
      .map((c) => {
        const hints = c.sourceHints as
          | { github_repos?: string[] }
          | undefined;
        return hints?.github_repos?.[0];
      })
      .filter((v): v is string => typeof v === "string");
    onChange(all.join(", "));
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-sm font-medium">
          {step.prompt}
          {step.required && <span className="ml-1 text-red-600">*</span>}
        </label>
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          {discovering ? "refreshing…" : "refresh"}
        </button>
      </div>

      {discovering && !discovery && (
        <p className="text-sm text-neutral-500">Listing your repos…</p>
      )}

      {discovery?.status === "failed" && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Couldn&apos;t discover repos: {discovery.error ?? "unknown error"}.
          Enter them manually below.
        </div>
      )}

      {discovery?.status === "ok" && discovery.candidates.length > 0 && (
        <div className="rounded-md border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-neutral-500">
            <span>
              {selected.size} selected · {discovery.candidates.length} found
            </span>
            <button
              type="button"
              onClick={selectAll}
              className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              select all
            </button>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {discovery.candidates.map((c) => {
              const hints = c.sourceHints as
                | { github_repos?: string[] }
                | undefined;
              const fullName = hints?.github_repos?.[0] ?? c.slug;
              const checked = selected.has(fullName);
              return (
                <label
                  key={fullName}
                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(fullName)}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{fullName}</div>
                    {c.description && (
                      <div className="truncate text-[11px] text-neutral-500">
                        {c.description}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {discovery?.status === "ok" && discovery.candidates.length === 0 && (
        <p className="text-xs text-neutral-500">
          No repos found. You can still type them manually below.
        </p>
      )}

      <input
        type="text"
        value={typeof value === "string" ? value : current.join(", ")}
        placeholder={step.placeholder ?? "owner/repo, comma-separated"}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-900"
      />
      <p className="mt-1 text-[11px] text-neutral-500">
        Raw list is editable if you prefer — any changes override the
        checklist selection.
      </p>
    </div>
  );
}
