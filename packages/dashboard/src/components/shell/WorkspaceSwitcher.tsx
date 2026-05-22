import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, FolderTree } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

/**
 * Top-bar dropdown listing every workspace. Switching mutates the
 * dashboard session's bound workspace via
 * `POST /api/dashboard/workspaces/switch` and invalidates every query
 * in the cache so subsequent reads scope to the new workspace.
 *
 * Shares its query + mutation hooks with the WorkspacesPage via the
 * exported `useDashboardWorkspaces` / `useSwitchWorkspace` hooks so a
 * "switch" action from either surface lands the same updates.
 */

export interface DashboardWorkspace {
  slug: string;
  isActive: boolean;
}

interface WorkspaceListResponse {
  workspaces: DashboardWorkspace[];
}

interface SwitchResponse {
  ok: true;
  workspace: string;
}

export function useDashboardWorkspaces() {
  return useQuery({
    queryKey: ["dashboard", "workspaces"],
    queryFn: () => api<WorkspaceListResponse>("/api/dashboard/workspaces"),
  });
}

export function useSwitchWorkspace() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  return useMutation({
    mutationFn: (slug: string) =>
      apiPost<SwitchResponse>("/api/dashboard/workspaces/switch", { slug }),
    async onSuccess() {
      // Whoami carries the active workspace; refresh + nuke caches so
      // workspace-scoped reads (logs, identity, etc.) refetch.
      await refresh();
      await qc.invalidateQueries();
    },
  });
}

const triggerClass =
  "inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function WorkspaceSwitcher(): React.ReactElement {
  const { data, isLoading } = useDashboardWorkspaces();
  const switchWs = useSwitchWorkspace();

  const active = data?.workspaces.find((w) => w.isActive);
  const label = active?.slug ?? "Select workspace";

  if (isLoading) {
    return <Skeleton className="h-9 w-40" />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Switch workspace" className={triggerClass}>
        <FolderTree className="size-4" />
        <span className="max-w-[12rem] truncate">{label}</span>
        <ChevronDown className="size-4 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(data?.workspaces ?? []).length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No workspaces yet.
          </div>
        )}
        {(data?.workspaces ?? []).map((ws) => (
          <DropdownMenuItem
            key={ws.slug}
            disabled={ws.isActive || switchWs.isPending}
            onClick={() => {
              if (!ws.isActive) switchWs.mutate(ws.slug);
            }}
          >
            <span className="flex w-full items-center justify-between gap-3">
              <span className="truncate">{ws.slug}</span>
              {ws.isActive && <Check className="size-4 text-muted-foreground" />}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ProfileMenuProps {
  onLogout: () => void;
}

export function ProfileMenu({ onLogout }: ProfileMenuProps): React.ReactElement {
  const { whoami } = useAuth();
  // Prefer GitHub identity (Device Flow) over the static token label.
  const githubLogin = whoami?.githubLogin ?? null;
  const githubAvatarUrl = whoami?.githubAvatarUrl ?? null;
  const label = githubLogin ?? whoami?.tokenLabel ?? "Account";
  const isGithub = Boolean(githubLogin);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Account menu" className={triggerClass}>
        {githubAvatarUrl ? (
          <img
            src={githubAvatarUrl}
            alt=""
            className="size-5 rounded-full"
            referrerPolicy="no-referrer"
          />
        ) : null}
        <span className="max-w-[10rem] truncate">{label}</span>
        <ChevronDown className="size-4 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          <span className="block text-xs uppercase tracking-wide">
            {isGithub ? "GitHub" : "Token"}
          </span>
          <span className="block truncate text-sm text-foreground">{label}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onLogout}>Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
