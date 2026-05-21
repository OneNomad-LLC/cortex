import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api } from "@/lib/api";
import { Play, Pause, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

type AdapterStatus = "idle" | "running" | "paused" | "error";

interface AdapterRow {
  id: string;
  kind: "adapter";
  slug: string;
  name: string;
  status: AdapterStatus;
  enabled: boolean;
  schedule: string | null;
  lastRunAt: string | null;
  lastRunIngested: number | null;
  lastError: string | null;
}

interface AdaptersResponse {
  adapters: AdapterRow[];
}

const STATUS_VARIANT: Record<
  AdapterStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  idle: "secondary",
  running: "default",
  paused: "outline",
  error: "destructive",
};

export function AdaptersListPage() {
  const queryClient = useQueryClient();
  const query = useQuery<AdaptersResponse>({
    queryKey: ["dashboard", "adapters"],
    queryFn: () => api<AdaptersResponse>("/api/dashboard/adapters"),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["dashboard", "adapters"] });

  return (
    <main className="flex-1 space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Adapters</h1>
          <p className="text-sm text-muted-foreground">
            Source connectors that pull content into Cortex.
          </p>
        </div>
        <Link href="/adapters/new">
          <Button>Add adapter</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configured adapters</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : query.isError ? (
            <p className="text-sm text-destructive">
              Failed to load adapters: {String(query.error)}
            </p>
          ) : query.data && query.data.adapters.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No adapters configured yet.{" "}
              <Link
                href="/adapters/new"
                className="underline underline-offset-4"
              >
                Add one
              </Link>
              .
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">Name</th>
                    <th className="pb-2 pr-3 font-medium">Status</th>
                    <th className="pb-2 pr-3 font-medium">Schedule</th>
                    <th className="pb-2 pr-3 font-medium">Last run</th>
                    <th className="pb-2 pr-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {query.data?.adapters.map((row) => (
                    <AdapterRow
                      key={row.id}
                      row={row}
                      onChanged={invalidate}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function AdapterRow(props: {
  row: AdapterRow;
  onChanged: () => void;
}) {
  const { row, onChanged } = props;
  const [_, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const action = useMutation({
    mutationFn: async (action: "pause" | "resume" | "trigger-fetch") => {
      setBusy(true);
      try {
        await api(`/api/dashboard/adapters/${row.id}/${action}`, {
          method: "POST",
        });
      } finally {
        setBusy(false);
      }
    },
    onSuccess: () => onChanged(),
  });

  const remove = useMutation({
    mutationFn: async () => {
      setBusy(true);
      try {
        await api(`/api/dashboard/adapters/${row.id}`, { method: "DELETE" });
      } finally {
        setBusy(false);
      }
    },
    onSuccess: () => {
      setDeleteOpen(false);
      onChanged();
    },
  });

  return (
    <tr className="border-t">
      <td className="py-2 pr-3">
        <button
          type="button"
          onClick={() => navigate(`/adapters/${row.id}`)}
          className="text-left font-medium underline-offset-4 hover:underline"
        >
          {row.name}
        </button>
        <p className="text-xs text-muted-foreground">{row.slug}</p>
      </td>
      <td className="py-2 pr-3">
        <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
        {row.lastError ? (
          <p className="text-xs text-destructive">{row.lastError}</p>
        ) : null}
      </td>
      <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
        {row.schedule ?? "—"}
      </td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">
        {row.lastRunAt ? new Date(row.lastRunAt).toLocaleString() : "—"}
        {row.lastRunIngested != null ? (
          <span className="ml-2 text-muted-foreground">
            ({row.lastRunIngested} ingested)
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-center justify-end gap-1">
          {row.enabled ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Pause"
              disabled={busy}
              onClick={() => action.mutate("pause")}
            >
              <Pause className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Resume"
              disabled={busy}
              onClick={() => action.mutate("resume")}
            >
              <Play className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Trigger fetch now"
            disabled={busy}
            onClick={() => action.mutate("trigger-fetch")}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Remove"
                disabled={busy}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {row.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete the adapter from cortex.yaml and remove
                  its declared secrets from .env. Memory already ingested
                  through this adapter stays in place.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={(e) => {
                    e.preventDefault();
                    remove.mutate();
                  }}
                >
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </td>
    </tr>
  );
}
