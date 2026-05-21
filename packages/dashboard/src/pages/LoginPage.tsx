import * as React from "react";
import { useForm } from "react-hook-form";
import { useLocation } from "wouter";
import { z } from "zod";

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
 * Login surface. The dashboard knows nothing about how tokens are
 * minted (`cortex dashboard mint` does that on the CLI) — it just
 * exchanges a raw token for a session cookie via
 * `POST /api/dashboard/auth/login`.
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

export function LoginPage(): React.ReactElement {
  const { refresh } = useAuth();
  const [, navigate] = useLocation();
  const [serverError, setServerError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormShape>({
    defaultValues: { token: "" },
  });

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
      navigate("/_dashboard/");
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

  return (
    <main className="flex min-h-full items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Paste a dashboard token to access this Cortex instance.
            Tokens are minted with{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              cortex dashboard mint
            </code>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="token">Dashboard token</Label>
              <Input
                id="token"
                type="password"
                autoComplete="current-password"
                autoFocus
                placeholder="paste your token"
                aria-invalid={Boolean(errors.token || serverError) || undefined}
                {...register("token")}
              />
              {errors.token?.message && (
                <p className="text-xs text-destructive">{errors.token.message}</p>
              )}
              {serverError && !errors.token?.message && (
                <p className="text-xs text-destructive" role="alert">
                  {serverError}
                </p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
