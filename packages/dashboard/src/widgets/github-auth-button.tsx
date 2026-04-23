"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "Connect to GitHub" button + inline modal for the device-flow
 * authorize dance. No PAT paste, no leaving the dashboard for the
 * terminal.
 *
 * Flow:
 *   1. Click "Connect to GitHub"
 *   2. Button calls POST /api/cortex/auth/github/start
 *   3. Modal appears with the short code; browser opens
 *      github.com/login/device in a new tab
 *   4. Component polls POST /api/cortex/auth/github/complete every
 *      ~3s until GitHub reports authorized / denied / expired
 *   5. On authorized: modal closes, `onAuthorized` fires so the
 *      parent (e.g. WizardForm) can skip the secrets step.
 */

interface StartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  pollIntervalSeconds: number;
}

interface CompleteResponse {
  status: "authorized" | "pending" | "denied" | "expired" | "error";
  scopes?: string[];
  hint?: string;
  error?: string;
}

interface StatusResponse {
  authenticated: boolean;
  scopes?: string[];
  grantedAt?: string;
}

export function GitHubAuthButton({
  onAuthorized,
  size = "default",
}: {
  onAuthorized?: (scopes: string[]) => void;
  size?: "default" | "compact";
}): React.JSX.Element {
  const [status, setStatus] = useState<StatusResponse | undefined>();
  const [grant, setGrant] = useState<StartResponse | undefined>();
  const [phase, setPhase] = useState<
    "idle" | "starting" | "waiting" | "done" | "denied" | "expired" | "error"
  >("idle");
  const [error, setError] = useState<string | undefined>();
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    void refreshStatus();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  async function refreshStatus(): Promise<void> {
    try {
      const res = await fetch("/api/cortex/auth/github/status", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as StatusResponse;
      setStatus(body);
      if (body.authenticated) setPhase("done");
    } catch {
      // Best-effort — if it fails we just show the connect button.
    }
  }

  async function startAuth(): Promise<void> {
    setPhase("starting");
    setError(undefined);
    try {
      const res = await fetch("/api/cortex/auth/github/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["repo"] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      const g = (await res.json()) as StartResponse;
      setGrant(g);
      setPhase("waiting");
      // Auto-open the verification page in a new tab so the user
      // doesn't have to hunt for the URL.
      window.open(g.verificationUri, "_blank", "noopener,noreferrer");
      scheduleNextPoll(g, Math.max(g.pollIntervalSeconds, 3) * 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function scheduleNextPoll(g: StartResponse, delayMs: number): void {
    pollTimer.current = setTimeout(() => {
      void poll(g, delayMs);
    }, delayMs);
  }

  async function poll(g: StartResponse, lastDelayMs: number): Promise<void> {
    if (new Date(g.expiresAt).getTime() < Date.now()) {
      setPhase("expired");
      return;
    }
    try {
      const res = await fetch("/api/cortex/auth/github/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: g.deviceCode }),
      });
      const body = (await res.json().catch(() => ({}))) as CompleteResponse;
      if (!res.ok && res.status !== 410) {
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      switch (body.status) {
        case "authorized":
          setPhase("done");
          setStatus({
            authenticated: true,
            ...(body.scopes ? { scopes: body.scopes } : {}),
          });
          onAuthorized?.(body.scopes ?? []);
          return;
        case "denied":
          setPhase("denied");
          return;
        case "expired":
          setPhase("expired");
          return;
        case "pending":
          // GitHub may have asked us to slow down.
          scheduleNextPoll(
            g,
            body.hint?.includes("slow down")
              ? lastDelayMs + 5_000
              : lastDelayMs,
          );
          return;
        default:
          throw new Error(body.error ?? "unknown auth status");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  // Already authenticated from a prior session? Show a quiet "connected" tag.
  if (phase === "done" && status?.authenticated) {
    return (
      <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full bg-emerald-500"
        />
        <span>
          GitHub connected
          {status.scopes && status.scopes.length > 0 ? (
            <span className="ml-1 text-xs text-neutral-500">
              (scopes: {status.scopes.join(", ")})
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => {
            setPhase("idle");
            setStatus(undefined);
            void startAuth();
          }}
          className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          reconnect
        </button>
      </div>
    );
  }

  // Idle or starting — simple button.
  if (phase === "idle" || phase === "starting") {
    const compact = size === "compact";
    return (
      <div>
        <button
          type="button"
          onClick={() => void startAuth()}
          disabled={phase === "starting"}
          className={
            compact
              ? "inline-flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
              : "inline-flex items-center gap-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          }
        >
          <GithubGlyph />
          {phase === "starting" ? "Starting…" : "Connect to GitHub"}
        </button>
        {error && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    );
  }

  // Waiting for authorization — show code + status.
  if (phase === "waiting" && grant) {
    return (
      <div className="rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
        <p className="text-sm font-medium text-blue-900 dark:text-blue-200">
          Waiting for GitHub authorization…
        </p>
        <p className="mt-2 text-sm text-blue-800 dark:text-blue-300">
          A new tab opened at{" "}
          <a
            href={grant.verificationUri}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            github.com/login/device
          </a>
          . If nothing happened, click the link. Then enter this code:
        </p>
        <div className="mt-3 flex items-center gap-3">
          <code className="select-all rounded bg-blue-900/10 px-3 py-1.5 font-mono text-xl font-bold tracking-widest text-blue-900 dark:bg-blue-950/50 dark:text-blue-100">
            {grant.userCode}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(grant.userCode);
            }}
            className="text-xs text-blue-700 underline hover:text-blue-900 dark:text-blue-300"
          >
            copy
          </button>
        </div>
        <p className="mt-3 text-xs text-blue-800 dark:text-blue-300">
          This page checks every few seconds. Once you approve, it&apos;ll
          update automatically.
        </p>
      </div>
    );
  }

  if (phase === "denied") {
    return (
      <Outcome kind="err">
        Authorization was declined. Run the flow again if you changed your
        mind.
        <RetryButton onClick={() => void startAuth()} />
      </Outcome>
    );
  }
  if (phase === "expired") {
    return (
      <Outcome kind="err">
        The device code expired before approval. Try again.
        <RetryButton onClick={() => void startAuth()} />
      </Outcome>
    );
  }
  if (phase === "error") {
    return (
      <Outcome kind="err">
        {error ?? "Unknown error."}
        <RetryButton onClick={() => void startAuth()} />
      </Outcome>
    );
  }
  return <></>;
}

function Outcome({
  kind,
  children,
}: {
  kind: "err";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={
        kind === "err"
          ? "rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
          : ""
      }
    >
      {children}
    </div>
  );
}

function RetryButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-2 text-xs underline"
    >
      try again
    </button>
  );
}

function GithubGlyph(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
