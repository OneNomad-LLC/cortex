/**
 * Query observability page — shows recent searches made via MCP so
 * admins can debug "why didn't it find X" without opening a support ticket.
 *
 * Data comes from GET /api/dashboard/queries, which reads the `query_log`
 * table written by the MCP kb_search hook. Until that hook is wired, the
 * page renders an informational empty state.
 *
 * Filters: user, project, since-date (forwarded as query params).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TopResult {
  id: string;
  score: number;
  snippet: string;
}

interface QueryRow {
  id: string;
  tenantId: string;
  userId: string | null;
  userEmail: string | null;
  agentLabel: string | null;
  project: string | null;
  queryText: string;
  resultCount: number;
  topResults: TopResult[];
  createdAt: string;
}

interface QueriesResponse {
  queries: QueryRow[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
}

const PER_PAGE = 50;

// ---------------------------------------------------------------------------
// Detail panel (expandable row)
// ---------------------------------------------------------------------------

function QueryDetail(props: { row: QueryRow }): React.ReactElement {
  const { row } = props;
  return (
    <tr className="border-t bg-muted/30">
      <td colSpan={5} className="px-3 py-3">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Top results ({row.topResults.length})
          </p>
          {row.topResults.length === 0 ? (
            <p className="text-xs text-muted-foreground">No results returned.</p>
          ) : (
            <ul className="space-y-1.5">
              {row.topResults.map((r) => (
                <li key={r.id} className="flex gap-3 text-xs">
                  <Badge variant="outline" className="shrink-0">
                    {r.score.toFixed(3)}
                  </Badge>
                  <span className="line-clamp-2 text-muted-foreground">
                    {r.snippet}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function QueriesPage(): React.ReactElement {
  const [userFilter, setUserFilter] = React.useState("");
  const [projectFilter, setProjectFilter] = React.useState("");
  const [sinceFilter, setSinceFilter] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const [debouncedUser, setDebouncedUser] = React.useState("");
  const [debouncedProject, setDebouncedProject] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedUser(userFilter.trim()), 300);
    return () => clearTimeout(t);
  }, [userFilter]);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedProject(projectFilter.trim()), 300);
    return () => clearTimeout(t);
  }, [projectFilter]);

  React.useEffect(() => {
    setPage(1);
  }, [debouncedUser, debouncedProject, sinceFilter]);

  const url = React.useMemo(() => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("perPage", String(PER_PAGE));
    if (debouncedUser) p.set("user", debouncedUser);
    if (debouncedProject) p.set("project", debouncedProject);
    if (sinceFilter) p.set("since", sinceFilter);
    return `/api/dashboard/queries?${p.toString()}`;
  }, [page, debouncedUser, debouncedProject, sinceFilter]);

  const queriesQuery = useQuery<QueriesResponse, ApiError>({
    queryKey: ["dashboard", "queries", url],
    queryFn: () => api<QueriesResponse>(url),
    refetchOnWindowFocus: false,
    refetchInterval: 10_000, // refresh every 10s so live searches appear quickly
  });

  const clearFilters = () => {
    setUserFilter("");
    setProjectFilter("");
    setSinceFilter("");
    setPage(1);
  };

  const hasFilters =
    debouncedUser !== "" || debouncedProject !== "" || sinceFilter !== "";

  const rows = queriesQuery.data?.queries ?? [];
  const total = queriesQuery.data?.total ?? 0;

  return (
    <main className="flex-1 space-y-4 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Search className="size-5" />
          Queries
        </h1>
        <p className="text-sm text-muted-foreground">
          Recent MCP searches — query text, ranked results, agent, and user.
        </p>
      </header>

      <Card>
        <CardContent className="space-y-3 pt-6">
          {/* Filters */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="q-user" className="text-xs">
                User
              </Label>
              <Input
                id="q-user"
                placeholder="email or ID"
                className="w-[12rem]"
                value={userFilter}
                onChange={(e) => setUserFilter(e.currentTarget.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="q-project" className="text-xs">
                Project
              </Label>
              <Input
                id="q-project"
                placeholder="project slug"
                className="w-[10rem]"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.currentTarget.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="q-since" className="text-xs">
                Since
              </Label>
              <Input
                id="q-since"
                type="date"
                className="w-[10rem]"
                value={sinceFilter}
                onChange={(e) => setSinceFilter(e.currentTarget.value)}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              disabled={!hasFilters}
            >
              <X className="size-4" />
              Reset
            </Button>
          </div>

          {/* Table */}
          {queriesQuery.isLoading ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : queriesQuery.isError ? (
            <p className="text-sm text-destructive">
              Failed to load queries:{" "}
              {queriesQuery.error.message ?? "unknown error"}
            </p>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {hasFilters
                  ? "No queries match the current filters."
                  : "No queries yet — MCP searches will appear here as they happen."}
              </p>
              {!hasFilters ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  The query log writes when the MCP kb_search hook is wired.
                  Auto-refreshing every 10s.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">Query</th>
                    <th className="pb-2 pr-3 font-medium">User</th>
                    <th className="pb-2 pr-3 font-medium">Project</th>
                    <th className="pb-2 pr-3 font-medium">Results</th>
                    <th className="pb-2 pr-3 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <React.Fragment key={row.id}>
                      <tr
                        className="cursor-pointer border-t hover:bg-muted/30"
                        onClick={() =>
                          setExpandedId((prev) =>
                            prev === row.id ? null : row.id,
                          )
                        }
                      >
                        <td className="py-2 pr-3 align-middle font-medium">
                          {row.queryText.length > 80
                            ? `${row.queryText.slice(0, 80)}…`
                            : row.queryText}
                        </td>
                        <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                          {row.userEmail ?? row.agentLabel ?? row.userId ?? "—"}
                        </td>
                        <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                          {row.project ?? "—"}
                        </td>
                        <td className="py-2 pr-3 align-middle">
                          <Badge variant="outline">{row.resultCount}</Badge>
                        </td>
                        <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                          {formatRelative(row.createdAt)}
                        </td>
                      </tr>
                      {expandedId === row.id ? (
                        <QueryDetail row={row} />
                      ) : null}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              {total === 0
                ? "0 queries"
                : `${(page - 1) * PER_PAGE + 1}–${Math.min(total, page * PER_PAGE)} of ${total}`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {page}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!(queriesQuery.data?.hasMore ?? false)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
