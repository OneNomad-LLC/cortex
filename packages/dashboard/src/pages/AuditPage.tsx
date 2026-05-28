/**
 * Audit feed — read-only paginated log of `audit_event` rows for the
 * tenant/org. Reads from GET /api/dashboard/audit which proxies to
 * przm-access `GET /admin/orgs/:id/audit`. Cursor-based pagination.
 *
 * Filters: since-date (ISO). The cursor from the previous page is carried
 * in component state; going "back" resets to the start.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, X } from "lucide-react";

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

interface AuditEvent {
  id: string;
  organizationId: string;
  tenantId: string | null;
  userId: string | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface AuditResponse {
  events: AuditEvent[];
  nextCursor: string | null;
}

const LIMIT = 50;

// ---------------------------------------------------------------------------
// Action badge colour map
// ---------------------------------------------------------------------------

function actionVariant(
  action: string,
): "default" | "destructive" | "outline" | "success" | "muted" {
  if (action.includes("delete") || action.includes("remove")) return "destructive";
  if (action.includes("create") || action.includes("invite")) return "success";
  if (action.includes("update") || action.includes("change") || action.includes("patch"))
    return "outline";
  return "muted";
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function AuditPage(): React.ReactElement {
  const [since, setSince] = React.useState("");
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<string[]>([]); // stack of previous cursors

  // Reset pagination when the since filter changes.
  React.useEffect(() => {
    setCursor(null);
    setHistory([]);
  }, [since]);

  const url = React.useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", String(LIMIT));
    if (since) p.set("since", since);
    if (cursor) p.set("cursor", cursor);
    return `/api/dashboard/audit?${p.toString()}`;
  }, [since, cursor]);

  const auditQuery = useQuery<AuditResponse, ApiError>({
    queryKey: ["dashboard", "audit", url],
    queryFn: () => api<AuditResponse>(url),
    refetchOnWindowFocus: false,
  });

  const goNext = () => {
    const next = auditQuery.data?.nextCursor;
    if (!next) return;
    setHistory((h) => [...h, cursor ?? ""]);
    setCursor(next);
  };

  const goPrev = () => {
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setCursor(prev ?? null);
  };

  const events = auditQuery.data?.events ?? [];
  const hasPrev = history.length > 0;
  const hasNext = Boolean(auditQuery.data?.nextCursor);

  return (
    <main className="flex-1 space-y-4 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ClipboardList className="size-5" />
          Audit log
        </h1>
        <p className="text-sm text-muted-foreground">
          Read-only event feed for this organization. Tenant-scoped via RLS.
        </p>
      </header>

      <Card>
        <CardContent className="space-y-3 pt-6">
          {/* Filter */}
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="audit-since" className="text-xs">
                Since
              </Label>
              <Input
                id="audit-since"
                type="date"
                className="w-[10rem]"
                value={since}
                onChange={(e) => setSince(e.currentTarget.value)}
              />
            </div>
            {since ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSince("")}
              >
                <X className="size-4" />
                Clear
              </Button>
            ) : null}
          </div>

          {/* Events */}
          {auditQuery.isLoading ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : auditQuery.isError ? (
            <p className="text-sm text-destructive">
              {auditQuery.error instanceof ApiError &&
              auditQuery.error.status === 400
                ? "Set PRZM_ACCESS_ADMIN_URL, PRZM_ACCESS_OPERATOR_KEY, and PRZM_ACCESS_ORG_ID in the workspace .env to enable the audit feed."
                : `Failed to load audit log: ${auditQuery.error.message}`}
            </p>
          ) : events.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              {auditQuery.data
                ? "No events found for the current filter."
                : "Audit log is empty."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">Action</th>
                    <th className="pb-2 pr-3 font-medium">Actor</th>
                    <th className="pb-2 pr-3 font-medium">Target</th>
                    <th className="pb-2 pr-3 font-medium">Tenant</th>
                    <th className="pb-2 pr-3 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => (
                    <tr key={ev.id} className="border-t">
                      <td className="py-2 pr-3 align-middle">
                        <Badge variant={actionVariant(ev.action)} className="font-mono text-xs">
                          {ev.action}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                        {ev.userId ? (
                          <span className="font-mono">{ev.userId.slice(0, 8)}…</span>
                        ) : (
                          "system"
                        )}
                      </td>
                      <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                        {ev.target ? (
                          <span className="font-mono">{ev.target.slice(0, 12)}…</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                        {ev.tenantId ? (
                          <span className="font-mono">{ev.tenantId.slice(0, 8)}…</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                        {formatDate(ev.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              {events.length > 0
                ? `Showing ${events.length} event${events.length === 1 ? "" : "s"}`
                : ""}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!hasPrev}
                onClick={goPrev}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!hasNext}
                onClick={goNext}
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

function formatDate(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "—";
  return new Date(d).toLocaleString();
}
