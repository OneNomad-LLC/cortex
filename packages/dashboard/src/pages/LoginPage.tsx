import * as React from "react";
import { useForm } from "react-hook-form";
import { useLocation } from "wouter";
import { z } from "zod";
import { Github } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

/**
 * Login surface. Two paths into the dashboard:
 *
 *   1. **Continue with GitHub** (recommended). Runs GitHub's [device
 *      authorization grant][device-grant] — the SPA gets a short code,
 *      sends the user to `github.com/login/device`, and polls the
 *      server until the auth code resolves into a session cookie.
 *
 *   2. **Token paste** (legacy / power user). Exchanges a CLI-minted
 *      dashboard token for a session cookie via
 *      `POST /api/dashboard/auth/login`. Kept so headless / scripted
 *      sign-ins keep working and so deployments without GitHub Apps
 *      configured still have a way in.
 *
 *   [device-grant]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 *
 * Form validation: zod schema enforces non-empty + ≥40 chars before
 * the request fires. The server enforces the actual hash match. We
 * surface its 401 / 429 as inline messages rather than full-page
 * errors so a wrong-token retry stays a quick keystroke away.
 */

const loginSchema = z.object({
  token: z
    .string()
    .min(1, "Token required")
    .min(40, "Dashboard tokens are at least 40 characters"),
});

type LoginFormShape = z.infer<typeof loginSchema>;

interface LoginResponse {
  ok: true;
  workspace: string;
  scopes: ReadonlyArray<"read" | "ingest" | "admin">;
  tokenLabel: string;
}

interface DeviceStartResponse {
  userCode: string;
  verificationUri: string;
  pollKey: string;
  /** ms between polls; server enforces a minimum even if we ignore. */
  intervalMs: number;
  /** ms until the device code expires server-side. */
  expiresInMs: number;
}

interface DevicePollPending {
  status: "pending";
  /**
   * Optional override: server may ask us to back off after a
   * `slow_down` from GitHub. Falls back to the start-call `intervalMs`.
   */
  tryAgainAfterMs?: number;
}

interface DevicePollAuthorized {
  status: "authorized";
  workspace: string;
  scopes: ReadonlyArray<"read" | "ingest" | "admin">;
  login?: string;
}

interface DevicePollFailed {
  status: "expired" | "denied" | "pollkey_unknown" | "not_allowlisted";
  message?: string;
  login?: string;
}

type DevicePollResponse =
  | DevicePollPending
  | DevicePollAuthorized
  | DevicePollFailed;

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "awaiting";
      userCode: string;
      verificationUri: string;
      pollKey: string;
      intervalMs: number;
      expiresAt: number;
    };

const DEFAULT_POLL_INTERVAL_MS = 5000;

export function LoginPage(): React.ReactElement {
  const { refresh } = useAuth();
  const [, navigate] = useLocation();
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [copied, setCopied] = React.useState(false);

  // Each call to start gets its own abort controller so unmount /
  // restart cancels the in-flight fetch and stops the polling timer.
  const abortRef = React.useRef<AbortController | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormShape>({
    defaultValues: { token: "" },
  });

  const cancelFlow = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase({ kind: "idle" });
    setCopied(false);
  }, []);

  // Cleanup on unmount.
  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    const parsed = loginSchema.safeParse(values);
    if (!parsed.success) {
      const first = parsed.error.errors[0]?.message ?? "Invalid token";
      setServerError(first);
      return;
    }
    try {
      await apiPost<LoginResponse>("/api/dashboard/auth/login", {
        token: parsed.data.token,
      });
      await refresh();
      // wouter's useLocation()[1] is base-aware — pass the base-relative
      // path or it double-nests (browser ends up at /_dashboard/_dashboard/).
      navigate("/");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setServerError("Invalid token");
          return;
        }
        if (err.status === 429) {
          setServerError("Rate limited; wait a minute");
          return;
        }
        if (err.status === 400) {
          setServerError("Token can't be empty");
          return;
        }
      }
      setServerError("Login failed. Try again in a moment.");
    }
  });

  const startGithubFlow = React.useCallback(async () => {
    setServerError(null);
    setCopied(false);
    setPhase({ kind: "starting" });
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/dashboard/auth/github/start", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Cortex-Dashboard": "1",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message ?? `Start failed (${res.status})`);
      }
      const data = (await res.json()) as DeviceStartResponse;
      const intervalMs =
        typeof data.intervalMs === "number" && data.intervalMs > 0
          ? data.intervalMs
          : DEFAULT_POLL_INTERVAL_MS;
      setPhase({
        kind: "awaiting",
        userCode: data.userCode,
        verificationUri: data.verificationUri,
        pollKey: data.pollKey,
        intervalMs,
        expiresAt: Date.now() + (data.expiresInMs ?? 600_000),
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setPhase({ kind: "idle" });
      setServerError(
        err instanceof Error
          ? err.message
          : "Couldn't start GitHub sign-in. Try again.",
      );
    }
  }, []);

  // Poll loop — runs whenever we're in `awaiting`. Re-runs the effect
  // when the pollKey or intervalMs changes so a restart wires a fresh
  // timer rather than racing two of them.
  React.useEffect(() => {
    if (phase.kind !== "awaiting") return;
    const controller = abortRef.current;
    if (!controller) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled || controller.signal.aborted) return;
      try {
        const res = await fetch("/api/dashboard/auth/github/poll", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Cortex-Dashboard": "1",
          },
          body: JSON.stringify({ pollKey: phase.pollKey }),
          signal: controller.signal,
        });
        // 403 not_allowlisted has a JSON body we want to surface inline.
        if (res.status === 403) {
          const body = (await res.json().catch(() => ({}))) as DevicePollFailed;
          setServerError(
            body.message ??
              `GitHub user ${body.login ?? ""} is not on the allow-list for this Cortex instance.`,
          );
          cancelled = true;
          setPhase({ kind: "idle" });
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            message?: string;
          };
          setServerError(body.message ?? `Poll failed (${res.status})`);
          cancelled = true;
          setPhase({ kind: "idle" });
          return;
        }
        const data = (await res.json()) as DevicePollResponse;
        if (data.status === "pending") {
          const delay = data.tryAgainAfterMs ?? phase.intervalMs;
          timer = setTimeout(tick, delay);
          return;
        }
        if (data.status === "authorized") {
          cancelled = true;
          await refresh();
          navigate("/");
          return;
        }
        // expired / denied / pollkey_unknown → reset
        cancelled = true;
        setServerError(failureMessage(data.status));
        setPhase({ kind: "idle" });
      } catch (err) {
        if (controller.signal.aborted || cancelled) return;
        // Network blip — try again after the configured interval. If
        // the user closed the tab, the unmount cleanup will abort us.
        timer = setTimeout(tick, phase.intervalMs);
        void err;
      }
    };

    // Kick off immediately so the user doesn't wait an extra interval.
    timer = setTimeout(tick, phase.intervalMs);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, refresh, navigate]);

  const onCopyCode = React.useCallback(async () => {
    if (phase.kind !== "awaiting") return;
    try {
      await navigator.clipboard.writeText(phase.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard may be unavailable on http:// hosts; fall back to a
      // do-nothing — the code is already on screen for manual copy.
    }
  }, [phase]);

  return (
    <main className="flex min-h-full items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Continue with GitHub or paste a CLI-minted dashboard token.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {phase.kind === "awaiting" ? (
            <DeviceAwaitingPanel
              userCode={phase.userCode}
              verificationUri={phase.verificationUri}
              copied={copied}
              onCopy={onCopyCode}
              onCancel={cancelFlow}
            />
          ) : (
            <div className="space-y-5">
              <Button
                type="button"
                variant="outline"
                className="w-full justify-center gap-2"
                onClick={() => void startGithubFlow()}
                disabled={phase.kind === "starting"}
                aria-label="Continue with GitHub"
              >
                <Github className="size-4" />
                {phase.kind === "starting"
                  ? "Starting…"
                  : "Continue with GitHub"}
              </Button>

              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>or sign in with a token</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <form className="space-y-4" onSubmit={onSubmit} noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="token">Dashboard token</Label>
                  <Input
                    id="token"
                    type="password"
                    autoComplete="current-password"
                    placeholder="paste your token"
                    aria-invalid={
                      Boolean(errors.token || serverError) || undefined
                    }
                    {...register("token")}
                  />
                  {errors.token?.message && (
                    <p className="text-xs text-destructive">
                      {errors.token.message}
                    </p>
                  )}
                  {serverError && !errors.token?.message && (
                    <p className="text-xs text-destructive" role="alert">
                      {serverError}
                    </p>
                  )}
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Signing in…" : "Sign in"}
                </Button>
              </form>

              <p className="text-xs text-muted-foreground">
                Tokens are minted with{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  cortex dashboard mint
                </code>
                .
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

interface DeviceAwaitingPanelProps {
  userCode: string;
  verificationUri: string;
  copied: boolean;
  onCopy: () => void;
  onCancel: () => void;
}

function DeviceAwaitingPanel(
  props: DeviceAwaitingPanelProps,
): React.ReactElement {
  const { userCode, verificationUri, copied, onCopy, onCancel } = props;
  return (
    <div className="space-y-5">
      <div className="space-y-2 text-center">
        <p className="text-sm text-muted-foreground">
          Enter this code on GitHub to finish signing in:
        </p>
        <p
          aria-label="device code"
          className="font-mono text-3xl font-semibold tracking-[0.3em]"
        >
          {userCode}
        </p>
        <div className="flex items-center justify-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCopy}>
            {copied ? "Copied" : "Copy code"}
          </Button>
          <Button asChild size="sm">
            <a
              href={verificationUri}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open github.com/login/device
            </a>
          </Button>
        </div>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Waiting for you to authorize on GitHub…
      </p>
      <div className="text-center">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function failureMessage(status: DevicePollFailed["status"]): string {
  switch (status) {
    case "expired":
      return "The GitHub code expired before you authorized. Try again.";
    case "denied":
      return "GitHub sign-in was cancelled.";
    case "pollkey_unknown":
      return "The sign-in session was lost. Try again.";
    case "not_allowlisted":
      return "Your GitHub user isn't on the allow-list for this Cortex instance.";
    default:
      return "GitHub sign-in failed. Try again.";
  }
}
