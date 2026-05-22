import * as React from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Github,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ApiError, api, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/components/ui/toast";

/**
 * GitHub repos directory. Renders the list returned by Slice B's
 * `GET /api/dashboard/github/repos`. Each row supports per-row sync,
 * disconnect (with optional memory purge), and a header-level
 * multi-select sync button that POSTs to `/repos/sync`.
 *
 * Two failure-mode branches matter:
 *
 *   1. `412 github_not_connected` — the dashboard session is valid
 *      but it doesn't have a GitHub access token. We render an empty
 *      state pointing the user back at the login flow rather than a
 *      generic error.
 *   2. Anything else — surface as an inline error.
 */

interface RepoRow {
  /** "owner/name" — Slice B's canonical id field. */
  fullName: string;
  /** GitHub repo id (numeric). Kept so we don't collide on renames. */
  id?: number;
  name: string;
  owner: string;
  htmlUrl: string;
  defaultBranch?: string | null;
  language?: string | null;
  pushedAt?: string | null;
  description?: string | null;
  /** Slice B fills these; ui treats as optional. */
  private?: boolean;
  archived?: boolean;
  fork?: boolean;
  ingested?: boolean;
  lastSyncedAt?: string | null;
  memoryCount?: number;
  lastSyncJobId?: string | null;
  /** Derived from `ingested` + lastSyncJobId state. */
  status?: "ingested" | "syncing" | "failed" | "unknown" | null;
  lastError?: string | null;
}

interface ReposResponse {
  repos: RepoRow[];
  total: number;
  hasMore: boolean;
  page?: number;
  perPage?: number;
}

interface NotConnectedShape {
  error: "github_not_connected";
}

const PER_PAGE = 100;

export function GitHubReposPage(): React.ReactElement {
  const [, navigate] = useLocation();
  const { logout } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [filter, setFilter] = React.useState("");
  const [debouncedFilter, setDebouncedFilter] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Hide archived + forked repos by default — most users don't want them
  // ingested, but we keep the toggle so power users can opt in.
  const [showArchivedAndForks, setShowArchivedAndForks] =
    React.useState(false);

  // Debounce the filter input so we don't refetch on every keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedFilter(filter.trim()), 250);
    return () => clearTimeout(t);
  }, [filter]);

  const repos = useQuery<ReposResponse, ApiError>({
    queryKey: ["dashboard", "github", "repos", page, debouncedFilter],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        per_page: String(PER_PAGE),
      });
      if (debouncedFilter) params.set("filter", debouncedFilter);
      return api<ReposResponse>(
        `/api/dashboard/github/repos?${params.toString()}`,
      );
    },
    staleTime: 5_000,
    refetchOnWindowFocus: false,
    // 412 = github_not_connected. Don't keep retrying the same failure
    // — render the empty state instead.
    retry: (count, err) => {
      if (err instanceof ApiError && err.status === 412) return false;
      return count < 1;
    },
  });

  const notConnected = isNotConnected(repos.error);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["dashboard", "github", "repos"],
    });

  const syncSelected = useMutation({
    mutationFn: async (slugs: string[]) => {
      return apiPost<{ jobs: Array<{ repo: string; jobId: string }> }>(
        "/api/dashboard/github/repos/sync",
        { repos: slugs },
      );
    },
    onSuccess: (data) => {
      toast({
        title: `${data.jobs.length} syncs queued`,
        description: "Open Jobs to follow progress.",
      });
      setSelected(new Set());
      invalidate();
    },
    onError: (err) => {
      toast({
        title: "Sync failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  if (notConnected) {
    return (
      <main className="flex-1 space-y-4 p-6">
        <header>
          <h1 className="text-2xl font-semibold">GitHub</h1>
          <p className="text-sm text-muted-foreground">
            Sync repos from GitHub into Cortex.
          </p>
        </header>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Github className="size-4" />
              GitHub isn't connected to this session
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Sign in with GitHub from the login page to authorize the
              dashboard to list your repositories.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => navigate("/login")}>
                Go to login
              </Button>
              <Button variant="outline" onClick={() => void logout()}>
                Re-authenticate
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  const rawRepos = repos.data?.repos ?? [];
  const visibleRepos = showArchivedAndForks
    ? rawRepos
    : rawRepos.filter((r) => !r.archived && !r.fork);
  const hiddenCount = rawRepos.length - visibleRepos.length;
  const allSelected =
    visibleRepos.length > 0 &&
    visibleRepos.every((repo) => selected.has(repo.fullName));

  const toggleAll = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        for (const repo of visibleRepos) next.add(repo.fullName);
      } else {
        for (const repo of visibleRepos) next.delete(repo.fullName);
      }
      return next;
    });
  };

  const toggleOne = (slug: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(slug);
      else next.delete(slug);
      return next;
    });
  };

  return (
    <main className="flex-1 space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Github className="size-5" />
            GitHub repositories
          </h1>
          <p className="text-sm text-muted-foreground">
            Pick the repos Cortex should ingest. New runs are idempotent —
            re-syncing a repo updates the existing memories, never duplicates.
          </p>
        </div>
      </header>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Filter by owner/name…"
              className="pl-8"
              value={filter}
              onChange={(e) => {
                setPage(1);
                setFilter(e.currentTarget.value);
              }}
              aria-label="Filter repositories"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowArchivedAndForks((v) => !v)}
              aria-label={
                showArchivedAndForks
                  ? "Hide archived + forks"
                  : "Show archived + forks"
              }
              title={
                hiddenCount > 0 && !showArchivedAndForks
                  ? `${hiddenCount} archived/fork repos hidden`
                  : undefined
              }
            >
              {showArchivedAndForks
                ? "Hide archived + forks"
                : hiddenCount > 0
                  ? `Show all (+${hiddenCount})`
                  : "Show all"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void repos.refetch()}
              disabled={repos.isFetching}
              aria-label="Refresh"
            >
              <RefreshCw className="size-4" />
              {repos.isFetching ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={selected.size === 0 || syncSelected.isPending}
              onClick={() =>
                syncSelected.mutate(Array.from(selected.values()))
              }
            >
              {syncSelected.isPending
                ? "Queuing…"
                : `Sync selected (${selected.size})`}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {repos.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading repos…</p>
          ) : repos.isError ? (
            <p className="text-sm text-destructive">
              Failed to load repos: {String(repos.error)}
            </p>
          ) : visibleRepos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {debouncedFilter
                ? `No repos match "${debouncedFilter}".`
                : "No repos visible. Re-authenticate to widen scope."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">
                      <Checkbox
                        aria-label="Select all"
                        checked={allSelected}
                        onCheckedChange={(v) => toggleAll(Boolean(v))}
                      />
                    </th>
                    <th className="pb-2 pr-3 font-medium">Repository</th>
                    <th className="pb-2 pr-3 font-medium">Owner</th>
                    <th className="pb-2 pr-3 font-medium">Language</th>
                    <th className="pb-2 pr-3 font-medium">Updated</th>
                    <th className="pb-2 pr-3 font-medium">Status</th>
                    <th className="pb-2 pr-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {visibleRepos.map((repo) => (
                    <RepoTableRow
                      key={repo.fullName}
                      repo={repo}
                      selected={selected.has(repo.fullName)}
                      onSelectionChange={(v) => toggleOne(repo.fullName, v)}
                      onChanged={invalidate}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {repos.data && repos.data.hasMore ? (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={repos.isFetching}
              >
                {repos.isFetching ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

function RepoTableRow(props: {
  repo: RepoRow;
  selected: boolean;
  onSelectionChange: (next: boolean) => void;
  onChanged: () => void;
}): React.ReactElement {
  const { repo, selected, onSelectionChange, onChanged } = props;
  const { toast } = useToast();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [purge, setPurge] = React.useState(false);

  const syncOne = useMutation({
    mutationFn: async () => {
      const [owner, name] = repo.fullName.split("/");
      return apiPost<{ jobId: string }>(
        `/api/dashboard/github/repos/${owner}/${name}/sync`,
      );
    },
    onSuccess: (data) => {
      const description = data.jobId ? `Job ${data.jobId}` : null;
      toast({
        title: `Sync queued for ${repo.fullName}`,
        ...(description ? { description } : {}),
      });
      onChanged();
    },
    onError: (err) => {
      toast({
        title: "Sync failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const [owner, name] = repo.fullName.split("/");
      const q = purge ? "?purge=true" : "?purge=false";
      return api<{ removed: boolean; memoriesPurged?: number }>(
        `/api/dashboard/github/repos/${owner}/${name}${q}`,
        { method: "DELETE" },
      );
    },
    onSuccess: (data) => {
      setDeleteOpen(false);
      const description = data.memoriesPurged
        ? `${data.memoriesPurged} memories purged.`
        : null;
      toast({
        title: `${repo.fullName} disconnected`,
        ...(description ? { description } : {}),
      });
      onChanged();
    },
    onError: (err) => {
      toast({
        title: "Disconnect failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  return (
    <tr className="border-t">
      <td className="py-2 pr-3 align-top">
        <Checkbox
          aria-label={`Select ${repo.fullName}`}
          checked={selected}
          onCheckedChange={(v) => onSelectionChange(Boolean(v))}
        />
      </td>
      <td className="py-2 pr-3 align-top">
        <a
          href={repo.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline-offset-4 hover:underline"
        >
          {repo.name}
        </a>
        {repo.description ? (
          <p className="text-xs text-muted-foreground">{repo.description}</p>
        ) : null}
      </td>
      <td className="py-2 pr-3 align-top text-xs text-muted-foreground">
        {repo.owner}
      </td>
      <td className="py-2 pr-3 align-top text-xs text-muted-foreground">
        {repo.language ?? "—"}
      </td>
      <td className="py-2 pr-3 align-top text-xs text-muted-foreground">
        {formatRelative(repo.pushedAt)}
      </td>
      <td className="py-2 pr-3 align-top">
        <StatusBadge
          status={deriveStatus(repo)}
          error={repo.lastError ?? null}
        />
      </td>
      <td className="relative py-2 pr-3 align-top text-right">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Actions for ${repo.fullName}`}
            disabled={syncOne.isPending || disconnect.isPending}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => syncOne.mutate()}
              disabled={syncOne.isPending}
            >
              <RefreshCw className="mr-2 size-4" />
              {deriveStatus(repo) === "ingested" ? "Resync" : "Sync now"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setDeleteOpen(true)}
              disabled={disconnect.isPending}
            >
              <Trash2 className="mr-2 size-4 text-destructive" />
              <span className="text-destructive">Disconnect</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect {repo.fullName}?</AlertDialogTitle>
              <AlertDialogDescription>
                Cortex stops syncing this repository. Memories already
                ingested stay in place by default.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <Checkbox
                checked={purge}
                onCheckedChange={(v) => setPurge(Boolean(v))}
              />
              Also purge memories ingested from this repo
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={disconnect.isPending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={disconnect.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  disconnect.mutate();
                }}
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </td>
    </tr>
  );
}

function StatusBadge(props: {
  status: RepoRow["status"];
  error?: string | null;
}): React.ReactElement {
  const { status, error } = props;
  if (status === "ingested") {
    return <Badge variant="success">Ingested ✓</Badge>;
  }
  if (status === "syncing") {
    return <Badge variant="warning">Syncing…</Badge>;
  }
  if (status === "failed") {
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="destructive">Failed</Badge>
        {error ? (
          <p className="max-w-xs truncate text-[10px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  return <Badge variant="muted">—</Badge>;
}

/**
 * Derive a Status from Slice B's row shape. `status` field is reserved
 * for future job-state propagation; today the backend only fills
 * `ingested`. Fall back to that boolean so the badge stays meaningful
 * even without lastSyncJobId.
 */
function deriveStatus(repo: RepoRow): RepoRow["status"] {
  if (repo.status) return repo.status;
  if (repo.ingested) return "ingested";
  return null;
}

function isNotConnected(err: unknown): err is ApiError {
  if (!(err instanceof ApiError)) return false;
  if (err.status !== 412) return false;
  const body = err.body as unknown as NotConnectedShape;
  return body?.error === "github_not_connected";
}

const RELATIVE_THRESHOLDS: Array<[number, string]> = [
  [60, "s"],
  [60, "m"],
  [24, "h"],
  [7, "d"],
  [4.348, "w"],
  [12, "mo"],
  [Number.POSITIVE_INFINITY, "y"],
];

function formatRelative(input?: string | null): string {
  if (!input) return "—";
  const d = Date.parse(input);
  if (!Number.isFinite(d)) return "—";
  let diff = (Date.now() - d) / 1000;
  if (diff < 5) return "just now";
  for (const [scale, unit] of RELATIVE_THRESHOLDS) {
    if (diff < scale) return `${Math.floor(diff)}${unit} ago`;
    diff /= scale;
  }
  return new Date(d).toLocaleDateString();
}
