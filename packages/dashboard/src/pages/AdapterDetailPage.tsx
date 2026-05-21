import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ApiError, api } from "@/lib/api";
import {
  REDACTED_SENTINEL,
  WizardForm,
  type WizardSpec,
} from "@/components/wizard";
import { useState } from "react";

interface AdapterDetail {
  id: string;
  kind: "adapter";
  slug: string;
  name: string;
  description: string | null;
  package: string;
  enabled: boolean;
  schedule: string | null;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  status: "idle" | "running" | "paused" | "error";
  lastRunAt: string | null;
  lastRunIngested: number | null;
  lastError: string | null;
}

const STATUS_VARIANT: Record<
  AdapterDetail["status"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  idle: "secondary",
  running: "default",
  paused: "outline",
  error: "destructive",
};

export function AdapterDetailPage() {
  const [match, params] = useRoute<{ id: string }>("/adapters/:id");
  const [, navigate] = useLocation();
  const id = match ? params.id : undefined;
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);

  const detail = useQuery<AdapterDetail>({
    queryKey: ["dashboard", "adapters", id],
    queryFn: () => api<AdapterDetail>(`/api/dashboard/adapters/${id!}`),
    enabled: Boolean(id),
  });
  const spec = useQuery<WizardSpec>({
    queryKey: ["dashboard", "wizard", "spec", "adapter", id],
    queryFn: () =>
      api<WizardSpec>(`/api/dashboard/wizard/spec/adapter/${id!}`),
    enabled: Boolean(id),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["dashboard", "adapters", id] });
    queryClient.invalidateQueries({ queryKey: ["dashboard", "adapters"] });
  };

  const action = useMutation({
    mutationFn: async (verb: "pause" | "resume" | "trigger-fetch") => {
      setBusy(true);
      try {
        await api(`/api/dashboard/adapters/${id!}/${verb}`, {
          method: "POST",
        });
      } finally {
        setBusy(false);
      }
    },
    onSuccess: () => invalidate(),
  });

  const remove = useMutation({
    mutationFn: async () => {
      setBusy(true);
      try {
        await api(`/api/dashboard/adapters/${id!}`, { method: "DELETE" });
      } finally {
        setBusy(false);
      }
    },
    onSuccess: () => navigate("/adapters"),
  });

  const save = useMutation({
    mutationFn: async (answers: Record<string, unknown>) => {
      try {
        return await api<{ ok: boolean }>("/api/dashboard/wizard/run", {
          method: "POST",
          body: { moduleKind: "adapter", moduleId: id, answers },
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 400 && err.body.errors) {
          return { ok: false, errors: err.body.errors };
        }
        throw err;
      }
    },
    onSuccess: (result) => {
      if (result.ok) invalidate();
    },
  });

  if (!match || !id) {
    return null;
  }
  if (detail.isLoading || spec.isLoading) {
    return (
      <main className="flex-1 p-6">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <main className="flex-1 p-6">
        <p className="text-sm text-destructive">
          Failed to load adapter: {String(detail.error)}
        </p>
        <Button variant="outline" onClick={() => navigate("/adapters")}>
          Back
        </Button>
      </main>
    );
  }
  if (spec.isError || !spec.data) {
    return (
      <main className="flex-1 p-6">
        <p className="text-sm text-destructive">
          Failed to load wizard spec: {String(spec.error)}
        </p>
        <Button variant="outline" onClick={() => navigate("/adapters")}>
          Back
        </Button>
      </main>
    );
  }

  // Merge saved config + redacted-secret sentinels for the form's
  // initial values. The PasswordStep treats `__REDACTED__` specially,
  // so secrets that are configured stay opaque until the user clicks
  // "Replace".
  const initialValues: Record<string, unknown> = {
    ...detail.data.config,
  };
  for (const [envVar, displayValue] of Object.entries(detail.data.secrets)) {
    if (displayValue === REDACTED_SENTINEL) {
      initialValues[envVar] = REDACTED_SENTINEL;
    }
  }

  return (
    <main className="flex-1 space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{detail.data.name}</h1>
          <p className="text-sm text-muted-foreground">
            {detail.data.description ?? detail.data.package}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[detail.data.status]}>
              {detail.data.status}
            </Badge>
            {detail.data.schedule ? (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {detail.data.schedule}
              </code>
            ) : null}
            {detail.data.lastRunAt ? (
              <span className="text-xs text-muted-foreground">
                Last run {new Date(detail.data.lastRunAt).toLocaleString()}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {detail.data.enabled ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => action.mutate("pause")}
            >
              Pause
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => action.mutate("resume")}
            >
              Resume
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => action.mutate("trigger-fetch")}
          >
            Trigger fetch
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={busy}>
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Delete {detail.data.name}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Removes the adapter from cortex.yaml and clears its
                  declared secrets from .env. Already-ingested memory is
                  left in place.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={(e) => {
                    e.preventDefault();
                    remove.mutate();
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
          <CardDescription>
            Edit any field and click Save. Secrets stay redacted until
            you click Replace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WizardForm
            spec={spec.data}
            initialValues={initialValues}
            submitLabel="Save"
            onSubmit={async (answers) => {
              const result = await save.mutateAsync(answers);
              if (result && !result.ok && "errors" in result) {
                return { errors: result.errors as Record<string, string> };
              }
            }}
          />
        </CardContent>
      </Card>
    </main>
  );
}
