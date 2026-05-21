/**
 * Dashboard Logs page.
 *
 * Polls `/api/dashboard/logs` every 3s via TanStack Query's
 * `refetchInterval`. Filters (level, adapter, since) flow into the
 * query key so each combination has its own cache slot. Hovering the
 * table pauses the auto-refresh so the user can read a row without it
 * scrolling away.
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
import { Input } from "@/components/ui/input";

type Level = "" | "debug" | "info" | "warn" | "error";

interface LogLine {
  ts: string;
  level: string;
  msg: string;
  adapter?: string;
  component?: string;
  [k: string]: unknown;
}

interface LogsResponse {
  lines: LogLine[];
  matched: number;
  limit: number;
  workspace: string;
}

function levelVariant(
  level: string,
): "default" | "secondary" | "warning" | "destructive" | "muted" {
  switch (level) {
    case "error":
      return "destructive";
    case "warn":
      return "warning";
    case "info":
      return "secondary";
    case "debug":
      return "muted";
    default:
      return "default";
  }
}

export default function LogsPage() {
  const [level, setLevel] = React.useState<Level>("");
  const [adapter, setAdapter] = React.useState("");
  const [since, setSince] = React.useState("");
  const [paused, setPaused] = React.useState(false);

  const params = new URLSearchParams();
  if (level) params.set("level", level);
  if (adapter) params.set("adapter", adapter);
  if (since) params.set("since", since);

  const { data, isLoading, error } = useQuery<LogsResponse>({
    queryKey: ["dashboard-logs", level, adapter, since],
    queryFn: () => apiFetch<LogsResponse>(`/api/dashboard/logs?${params.toString()}`),
    refetchInterval: paused ? false : 3000,
    refetchIntervalInBackground: false,
  });

  return (
    <section className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
        <p className="text-sm text-muted-foreground">
          Live tail of Cortex's runtime log. Filters apply server-side. Hover
          the table to pause auto-refresh.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Level
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as Level)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">all</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Adapter
          <Input
            value={adapter}
            onChange={(e) => setAdapter(e.target.value)}
            placeholder="loom, github, …"
            className="w-44"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Since (ISO)
          <Input
            value={since}
            onChange={(e) => setSince(e.target.value)}
            placeholder="2026-05-20T10:00:00Z"
            className="w-64"
          />
        </label>

        <div className="ml-auto text-xs text-muted-foreground">
          {paused ? "paused" : "polling every 3s"} · {data?.matched ?? 0} matched
        </div>
      </div>

      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        className="rounded-md border"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-44">Time</TableHead>
              <TableHead className="w-20">Level</TableHead>
              <TableHead className="w-40">Adapter</TableHead>
              <TableHead>Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {error && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-destructive">
                  {String((error as { error?: string }).error ?? error)}
                </TableCell>
              </TableRow>
            )}
            {data?.lines.slice().reverse().map((line, idx) => (
              <TableRow key={`${line.ts}-${idx}`}>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {line.ts}
                </TableCell>
                <TableCell>
                  <Badge variant={levelVariant(line.level)}>{line.level}</Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {line.adapter ?? line.component ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs">{line.msg}</TableCell>
              </TableRow>
            ))}
            {data?.lines.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  No log lines match these filters yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
