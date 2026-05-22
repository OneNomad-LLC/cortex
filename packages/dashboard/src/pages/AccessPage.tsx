import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Github, Loader2, Plus, Trash2, UserCog } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
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
import { api, apiPost, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/components/ui/toast";

/**
 * Settings → Access. The dashboard's GitHub OAuth allowlist
 * (`PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST` in the workspace `.env`)
 * surfaced as a regular CRUD page so the operator can add/remove
 * sign-in-eligible GitHub users without SSHing the box.
 *
 * Self-removal is allowed but warned against in the confirm dialog —
 * the operator may need this to rotate themselves out of a workspace
 * they no longer own, and we shouldn't make that require shell access.
 */

const addSchema = z.object({
  login: z
    .string()
    .min(1, "Login required")
    .regex(
      /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
      "Doesn't look like a GitHub username (a-z, 0-9, hyphens; ≤39 chars)",
    ),
});

type AddFormShape = z.infer<typeof addSchema>;

interface AllowlistResponse {
  entries: string[];
}

export function AccessPage(): React.ReactElement {
  const { whoami } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const selfLogin = whoami?.githubLogin ?? null;

  const entriesQuery = useQuery<AllowlistResponse, ApiError>({
    queryKey: ["dashboard", "settings", "allowlist"],
    queryFn: () => api<AllowlistResponse>("/api/dashboard/settings/allowlist"),
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["dashboard", "settings", "allowlist"],
    });

  const addMutation = useMutation({
    mutationFn: async (login: string) =>
      apiPost<AllowlistResponse>("/api/dashboard/settings/allowlist", {
        login,
      }),
    onSuccess: (data) => {
      toast({
        title: `Added ${data.entries[data.entries.length - 1]}`,
        description: "They can sign in via 'Continue with GitHub' now.",
      });
      invalidate();
    },
    onError: (err) => {
      toast({
        title: "Couldn't add user",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (login: string) =>
      api<AllowlistResponse>(
        `/api/dashboard/settings/allowlist/${encodeURIComponent(login)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, login) => {
      toast({
        title: `Removed ${login}`,
        description: "Their next sign-in attempt will be rejected.",
      });
      invalidate();
    },
    onError: (err) => {
      toast({
        title: "Couldn't remove user",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AddFormShape>({ defaultValues: { login: "" } });

  const onSubmit = handleSubmit(async (values) => {
    const parsed = addSchema.safeParse(values);
    if (!parsed.success) return;
    await addMutation.mutateAsync(parsed.data.login.trim());
    reset({ login: "" });
  });

  const entries = entriesQuery.data?.entries ?? [];

  return (
    <main className="flex-1 space-y-4 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <UserCog className="size-5" />
          Access
        </h1>
        <p className="text-sm text-muted-foreground">
          GitHub users who can sign in to this Cortex dashboard via
          "Continue with GitHub". Empty list + a public-bound install
          locks everyone out — keep at least one entry.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a GitHub user</CardTitle>
          <CardDescription>
            Their next visit to <code>/_dashboard/login</code> will
            authenticate against the GitHub user with this login.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex items-start gap-2">
            <div className="flex-1">
              <Label htmlFor="login" className="sr-only">
                GitHub username
              </Label>
              <Input
                id="login"
                placeholder="e.g. mattstvartak"
                aria-invalid={Boolean(errors.login)}
                {...register("login")}
              />
              {errors.login ? (
                <p
                  role="alert"
                  className="mt-1 text-xs text-destructive"
                >
                  {errors.login.message}
                </p>
              ) : null}
            </div>
            <Button
              type="submit"
              disabled={isSubmitting || addMutation.isPending}
            >
              {addMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Adding…
                </>
              ) : (
                <>
                  <Plus className="mr-2 size-4" />
                  Add
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Allowlist ({entries.length})
          </CardTitle>
          <CardDescription>
            Stored in the active workspace's <code>.env</code> as{" "}
            <code>PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entriesQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : entriesQuery.error ? (
            <p className="text-sm text-destructive">
              Failed to load allowlist:{" "}
              {entriesQuery.error.message ?? "unknown error"}
            </p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No users yet. Add yourself first.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {entries.map((login) => (
                <li
                  key={login}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="flex items-center gap-2 text-sm">
                    <Github className="size-4 text-muted-foreground" />
                    <code>{login}</code>
                    {selfLogin?.toLowerCase() === login.toLowerCase() ? (
                      <span className="text-xs text-muted-foreground">
                        (you)
                      </span>
                    ) : null}
                  </span>
                  <RemoveButton
                    login={login}
                    isSelf={
                      selfLogin?.toLowerCase() === login.toLowerCase()
                    }
                    onRemove={() => removeMutation.mutateAsync(login)}
                    isPending={removeMutation.isPending}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function RemoveButton(props: {
  login: string;
  isSelf: boolean;
  onRemove: () => Promise<unknown>;
  isPending: boolean;
}): React.ReactElement {
  const { login, isSelf, onRemove, isPending } = props;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove ${login}`}
          disabled={isPending}
        >
          <Trash2 className="size-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {login}?</AlertDialogTitle>
          <AlertDialogDescription>
            {isSelf
              ? "You're removing your own GitHub user. Your current session stays valid for its 24-hour cookie window, but you won't be able to sign back in after that without SSH access to the box."
              : `${login} will no longer be able to sign in via "Continue with GitHub". Existing sessions stay valid for their cookie window.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onRemove()}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
