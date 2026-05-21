import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApiError, api } from "@/lib/api";
import { WizardForm, type WizardSpec } from "@/components/wizard";

interface ModuleListItem {
  id: string;
  kind: "adapter" | "provider" | "memory" | "toolkit" | "webhook";
  name: string;
  description?: string;
}

interface ModuleListResponse {
  modules: ModuleListItem[];
}

/**
 * Two-step add flow:
 *   1. Pick a module from the adapter catalog.
 *   2. Run its WizardForm; submit POSTs to `/api/dashboard/wizard/run`
 *      and on success the SPA navigates to the adapters list.
 */
export function AdapterAddPage() {
  const [, navigate] = useLocation();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const list = useQuery<ModuleListResponse>({
    queryKey: ["dashboard", "wizard", "list", "adapter"],
    queryFn: () =>
      api<ModuleListResponse>(
        "/api/dashboard/wizard/list?category=adapter",
      ),
  });

  if (!selectedId) {
    return (
      <main className="flex-1 space-y-4 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Add adapter</h1>
          <p className="text-sm text-muted-foreground">
            Pick a source you want Cortex to ingest from.
          </p>
        </div>
        {list.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : list.isError ? (
          <p className="text-sm text-destructive">
            Failed to load module list: {String(list.error)}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.data?.modules.map((mod) => (
              <button
                key={mod.id}
                type="button"
                onClick={() => setSelectedId(mod.id)}
                className="text-left"
              >
                <Card className="h-full transition-colors hover:bg-accent">
                  <CardHeader>
                    <CardTitle className="text-base">{mod.name}</CardTitle>
                    {mod.description ? (
                      <CardDescription>{mod.description}</CardDescription>
                    ) : null}
                  </CardHeader>
                </Card>
              </button>
            ))}
          </div>
        )}
        <Button variant="ghost" onClick={() => navigate("/adapters")}>
          Cancel
        </Button>
      </main>
    );
  }

  return (
    <AdapterConfigureStep
      moduleId={selectedId}
      onCancel={() => setSelectedId(undefined)}
      onSaved={() => navigate("/adapters")}
    />
  );
}

function AdapterConfigureStep(props: {
  moduleId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { moduleId, onCancel, onSaved } = props;
  const queryClient = useQueryClient();
  const spec = useQuery<WizardSpec>({
    queryKey: ["dashboard", "wizard", "spec", "adapter", moduleId],
    queryFn: () =>
      api<WizardSpec>(`/api/dashboard/wizard/spec/adapter/${moduleId}`),
  });

  const submit = useMutation({
    mutationFn: async (answers: Record<string, unknown>) => {
      try {
        return await api<{ ok: boolean }>("/api/dashboard/wizard/run", {
          method: "POST",
          body: { moduleKind: "adapter", moduleId, answers },
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 400 && err.body.errors) {
          return { ok: false, errors: err.body.errors };
        }
        throw err;
      }
    },
    onSuccess: (result) => {
      if (result.ok) {
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "adapters"],
        });
        onSaved();
      }
    },
  });

  if (spec.isLoading) {
    return (
      <main className="flex-1 p-6">
        <p className="text-sm text-muted-foreground">Loading wizard…</p>
      </main>
    );
  }
  if (spec.isError || !spec.data) {
    return (
      <main className="flex-1 space-y-3 p-6">
        <p className="text-sm text-destructive">
          Failed to load wizard: {String(spec.error)}
        </p>
        <Button variant="outline" onClick={onCancel}>
          Back to catalog
        </Button>
      </main>
    );
  }

  return (
    <main className="flex-1 space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Configure {spec.data.name}</h1>
        <p className="text-sm text-muted-foreground">{spec.data.description}</p>
      </div>
      <WizardForm
        spec={spec.data}
        submitLabel="Save adapter"
        onCancel={onCancel}
        onSubmit={async (answers) => {
          const result = await submit.mutateAsync(answers);
          if (result && !result.ok && "errors" in result) {
            return { errors: result.errors as Record<string, string> };
          }
        }}
      />
    </main>
  );
}
