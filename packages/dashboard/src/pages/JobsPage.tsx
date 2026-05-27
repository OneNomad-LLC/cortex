/**
 * Dashboard Jobs page.
 *
 * Two stacked tables, both fed from `/api/dashboard/jobs`:
 *   - "In flight" (queued + running) — polled every 5s.
 *   - "Recent" (completed + failed in last 24h) — polled every 15s.
 *
 * Job rows are clickable; clicking opens an inline detail strip with
 * progress and error tooltip. Job ids are truncated with a copy button
 * so the operator can grab the full UUID for a kb_job_status poll.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface JobView {
  jobId: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed";
  workspace: string;
  progress: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface JobsResponse {
  jobs: JobView[];
  utilization: { active: number; waiting: number; max: number };
  workspace: string;
}

function statusVariant(
  status: JobView["status"],
): "secondary" | "default" | "success" | "destructive" {
  switch (status) {
    case "queued":
      return "secondary";
    case "running":
      return "default";
    case "completed":
      return "success";
    case "failed":
      return "destructive";
  }
}

function progressPercent(progress: Record<string, unknown> | null): number | null {
  if (!progress) return null;
  const total = Number(progress.totalUnits);
  const done = Number(progress.doneUnits);
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked — quiet */
        }
      }}
      className="h-6 px-2 text-xs"
    >
      {done ? "copied" : "copy"}
    </Button>
  );
}

function JobsTable({
  title,
  description,
  data,
  error,
  isLoading,
  refreshing,
}: {
  title: string;
  description: string;
  data: JobView[] | undefined;
  error?: Error | null;
  isLoading: boolean;
  refreshing: boolean;
}) {
  return (
    <div className="rounded-md border">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="text-xs text-muted-foreground">
          {refreshing ? "refreshing…" : `${data?.length ?? 0} jobs`}
        </span>
      </header>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Id</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Finished</TableHead>
            <TableHead>Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={7} className="py-4">
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              </TableCell>
            </TableRow>
          )}
          {!isLoading && error && (
            <TableRow>
              <TableCell colSpan={7} className="py-6 text-center text-destructive">
                Failed to load jobs: {error.message}
              </TableCell>
            </TableRow>
          )}
          {!isLoading && !error && data?.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                Nothing here yet.
              </TableCell>
            </TableRow>
          )}
          {data?.map((job) => {
            const pct = progressPercent(job.progress);
            return (
              <TableRow key={job.jobId}>
                <TableCell className="font-mono text-xs">
                  <span title={job.jobId}>{shortId(job.jobId)}</span>
                  <CopyButton value={job.jobId} />
                </TableCell>
                <TableCell className="text-xs">{job.type}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {pct !== null ? `${pct}%` : "—"}
                  {typeof job.progress?.message === "string" && (
                    <div className="text-[10px] text-muted-foreground">
                      {job.progress.message}
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {job.startedAt ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {job.finishedAt ?? "—"}
                </TableCell>
                <TableCell className="max-w-md text-xs text-muted-foreground">
                  {job.error ? (
                    <span className="text-destructive" title={job.error}>
                      {job.error.length > 60 ? `${job.error.slice(0, 60)}…` : job.error}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function JobsPage() {
  const inflight = useQuery<JobsResponse, Error>({
    queryKey: ["dashboard-jobs", "in_progress"],
    queryFn: () =>
      apiFetch<JobsResponse>(`/api/dashboard/jobs?status=in_progress&limit=50`),
    refetchInterval: 5000,
  });
  const recent = useQuery<JobsResponse, Error>({
    queryKey: ["dashboard-jobs", "recent"],
    queryFn: () =>
      apiFetch<JobsResponse>(`/api/dashboard/jobs?status=recent&limit=100`),
    refetchInterval: 15_000,
  });

  return (
    <section className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <p className="text-sm text-muted-foreground">
          Background ingest jobs. Polls every 5s for in-flight, every 15s for recent.
        </p>
        {inflight.data?.utilization && (
          <p className="text-xs text-muted-foreground">
            Concurrency: {inflight.data.utilization.active} active ·{" "}
            {inflight.data.utilization.waiting} waiting · cap{" "}
            {inflight.data.utilization.max}
          </p>
        )}
      </header>

      <JobsTable
        title="In flight"
        description="Queued + running"
        data={inflight.data?.jobs}
        error={inflight.error}
        isLoading={inflight.isLoading}
        refreshing={inflight.isFetching && !inflight.isLoading}
      />

      <JobsTable
        title="Recent"
        description="Completed + failed within 24h"
        data={recent.data?.jobs}
        error={recent.error}
        isLoading={recent.isLoading}
        refreshing={recent.isFetching && !recent.isLoading}
      />
    </section>
  );
}
