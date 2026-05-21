/**
 * Dashboard Stats page.
 *
 * Card grid with total chunks + recent activity counters at the top
 * and a per-source bar chart (recharts) below. Polls every 30s — KB
 * size doesn't move minute-to-minute so a slower cadence reduces
 * engram chatter.
 */

import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface StatsResponse {
  kb: {
    healthy: boolean;
    message: string;
    lastSuccessAt: string | null;
    total_chunks?: number;
    total_size_bytes?: number;
    total_embeddings?: number;
    [k: string]: unknown;
  };
  sources: Array<{ source: string; count: number; lastIngestAt: string | null }>;
  recentActivity: { last24h: number; last7d: number };
  workspace: string;
}

function statNumber(n: unknown): string {
  if (typeof n !== "number") return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function StatCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="text-xs uppercase tracking-wide">
          {title}
        </CardDescription>
        <CardTitle className="text-3xl font-semibold">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export default function StatsPage() {
  const { data, isLoading, error } = useQuery<StatsResponse>({
    queryKey: ["dashboard-stats"],
    queryFn: () => apiFetch<StatsResponse>(`/api/dashboard/stats`),
    refetchInterval: 30_000,
  });

  return (
    <section className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Stats</h1>
        <p className="text-sm text-muted-foreground">
          Knowledge-base size + per-source breakdown for the active workspace.
        </p>
      </header>

      {isLoading && <div className="text-muted-foreground">Loading…</div>}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {(error as { error?: string }).error ?? String(error)}
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Total chunks"
              value={statNumber(data.kb.total_chunks)}
              hint={data.kb.healthy ? "Backend healthy" : data.kb.message}
            />
            <StatCard
              title="Total embeddings"
              value={statNumber(data.kb.total_embeddings)}
            />
            <StatCard
              title="Last 24h"
              value={String(data.recentActivity.last24h)}
              hint="ingested chunks"
            />
            <StatCard
              title="Last 7 days"
              value={String(data.recentActivity.last7d)}
              hint="ingested chunks"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Per source</CardTitle>
              <CardDescription>
                Chunk count by source for workspace{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  {data.workspace || "—"}
                </code>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.sources.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  No source data yet. Ingest something to populate this chart.
                </div>
              ) : (
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={data.sources}
                      margin={{ top: 8, right: 8, left: 0, bottom: 24 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                      <XAxis
                        dataKey="source"
                        stroke="currentColor"
                        fontSize={11}
                        angle={-30}
                        textAnchor="end"
                      />
                      <YAxis stroke="currentColor" fontSize={11} allowDecimals={false} />
                      <Tooltip
                        cursor={{ fillOpacity: 0.06 }}
                        contentStyle={{
                          background: "var(--background, #fff)",
                          borderRadius: 6,
                          border: "1px solid hsl(var(--border, 220 13% 91%))",
                          fontSize: 12,
                        }}
                      />
                      <Bar dataKey="count" fill="hsl(var(--primary, 222 47% 11%))" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="mt-4 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                {data.sources.map((s) => (
                  <div key={s.source} className="flex justify-between">
                    <span>{s.source}</span>
                    <span>
                      {s.count}
                      {s.lastIngestAt ? ` · last ${s.lastIngestAt}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}
