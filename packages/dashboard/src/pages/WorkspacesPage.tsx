import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Check, Loader2, Plus } from "lucide-react";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiPost } from "@/lib/api";
import {
  useDashboardWorkspaces,
  useSwitchWorkspace,
} from "@/components/shell/WorkspaceSwitcher";

/**
 * Workspaces page — full-page version of the top-bar switcher with
 * the additional "Create new" affordance. Switching from either
 * surface goes through the same mutation hook so the active marker
 * stays consistent.
 */

const createSchema = z.object({
  slug: z
    .string()
    .min(1, "Slug required")
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Slug must be kebab-case (a-z, 0-9, -)"),
  fromPath: z.string().optional(),
});

type CreateFormShape = z.infer<typeof createSchema>;

interface CreateResponse {
  ok: true;
  workspace: { slug: string; path: string };
}

export function WorkspacesPage(): React.ReactElement {
  const { data, isLoading, error } = useDashboardWorkspaces();
  const switchWs = useSwitchWorkspace();
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
          <p className="text-sm text-muted-foreground">
            Switch the active workspace for this dashboard session, or
            create a new one.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New workspace
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>All workspaces</CardTitle>
          <CardDescription>
            Switching here updates the dashboard session's bound
            workspace immediately. The CLI's active pointer is
            untouched — use{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              cortex workspace switch
            </code>{" "}
            to change that.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
          {error && (
            <p className="text-sm text-destructive">
              Failed to load workspaces.
            </p>
          )}
          {data && data.workspaces.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No workspaces yet. Hit "New workspace" to create one.
            </p>
          )}
          {data && data.workspaces.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="pb-2">Slug</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.workspaces.map((ws) => (
                  <tr key={ws.slug} className="border-t border-border">
                    <td className="py-2 font-mono">{ws.slug}</td>
                    <td className="py-2">
                      {ws.isActive ? (
                        <Badge variant="secondary" className="gap-1">
                          <Check className="size-3" /> Active
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Idle
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={ws.isActive || switchWs.isPending}
                        onClick={() => switchWs.mutate(ws.slug)}
                      >
                        {switchWs.isPending &&
                        switchWs.variables === ws.slug ? (
                          <>
                            <Loader2 className="size-3 animate-spin" />
                            Switching…
                          </>
                        ) : (
                          "Switch"
                        )}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {switchWs.error && (
            <p className="mt-3 text-xs text-destructive">
              {switchWs.error instanceof ApiError
                ? switchWs.error.body.error
                : "Switch failed"}
            </p>
          )}
        </CardContent>
      </Card>

      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: CreateWorkspaceDialogProps): React.ReactElement {
  const qc = useQueryClient();
  const [serverError, setServerError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateFormShape>({ defaultValues: { slug: "", fromPath: "" } });

  const createMut = useMutation({
    mutationFn: (values: CreateFormShape) =>
      apiPost<CreateResponse>("/api/dashboard/workspaces/create", {
        slug: values.slug,
        ...(values.fromPath ? { fromPath: values.fromPath } : {}),
      }),
    async onSuccess() {
      await qc.invalidateQueries({ queryKey: ["dashboard", "workspaces"] });
      reset();
      onOpenChange(false);
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    const parsed = createSchema.safeParse(values);
    if (!parsed.success) {
      setServerError(parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    try {
      await createMut.mutateAsync(parsed.data);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setServerError(`Workspace "${parsed.data.slug}" already exists`);
          return;
        }
        setServerError(err.body.error ?? "Create failed");
        return;
      }
      setServerError("Create failed");
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          setServerError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            Creates a new workspace bundle on disk. Optionally seeds
            its config from an existing directory.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="slug">Slug</Label>
            <Input
              id="slug"
              placeholder="my-workspace"
              aria-invalid={Boolean(errors.slug) || undefined}
              {...register("slug")}
            />
            {errors.slug?.message && (
              <p className="text-xs text-destructive">{errors.slug.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fromPath">From path (optional)</Label>
            <Input
              id="fromPath"
              placeholder="/path/to/existing/cortex/config"
              {...register("fromPath")}
            />
            <p className="text-xs text-muted-foreground">
              Copies <code>config/*.yaml</code> + <code>.env</code> from
              this path. Leave blank for a blank-slate workspace.
            </p>
          </div>
          {serverError && (
            <p className="text-xs text-destructive" role="alert">
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
