/**
 * Adapters page — merged "Connectors directory" + "configured adapter ops"
 * in one surface.
 *
 * Top section: connector cards (every source Cortex can ingest from),
 * connection badges, connect/reconfigure CTAs, and a first-run "Start
 * here" banner.
 *
 * Bottom section: the ops table for adapters already configured in
 * cortex.yaml (pause/resume/trigger-fetch/remove). Hidden while no
 * adapters exist so first-run users see only the cards.
 *
 * Connection-status logic (mirrors the old ConnectorsPage):
 *   - GitHub: probed via GET /api/dashboard/github/repos (OAuth session).
 *   - Everything else: matched against the YAML adapter list by id/slug.
 */

import * as React from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Github,
  HardDrive,
  Layers,
  Library,
  ListChecks,
  MessageSquare,
  Notebook,
  Pause,
  Play,
  Plug,
  RefreshCw,
  Trash2,
  Trello,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { CONNECTORS, type ConnectorDef } from "@/lib/connectors";
import { renderMarkdown } from "@/lib/markdown";
import { WizardForm, type WizardSpec } from "@/components/wizard";
import { useToast } from "@/components/ui/toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectionState = "connected" | "disconnected" | "unknown";
type RepoMode = "dossier" | "full" | "both";
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

// Slim shape used only for connection-probe id matching.
interface AdapterIdRow {
  id: string;
  slug: string;
  name: string;
}

interface AdaptersIdResponse {
  adapters: AdapterIdRow[];
}

interface GithubProbeResponse {
  adapterMode?: RepoMode | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECTOR_ICONS: Record<string, LucideIcon> = {
  github: Github,
  slack: MessageSquare,
  notion: Notebook,
  confluence: Library,
  jira: ListChecks,
  bitbucket: Boxes,
  linear: Trello,
  loom: Video,
  obsidian: HardDrive,
};

const MODE_SUBTITLES: Record<RepoMode, string> = {
  dossier: "Dossier mode (recommended)",
  full: "Full source mode",
  both: "Both modes",
};

const STATUS_VARIANT: Record<
  AdapterStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  idle: "secondary",
  running: "default",
  paused: "outline",
  error: "destructive",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AdaptersListPage() {
  const queryClient = useQueryClient();
  const [activeConnector, setActiveConnector] =
    React.useState<ConnectorDef | null>(null);

  // Full adapter rows (for the ops table at the bottom).
  const adaptersQuery = useQuery<AdaptersResponse>({
    queryKey: ["dashboard", "adapters"],
    queryFn: () => api<AdaptersResponse>("/api/dashboard/adapters"),
    refetchOnWindowFocus: false,
  });

  // GitHub connection probe — cheap 1-item request.
  const github = useQuery<GithubProbeResponse, ApiError>({
    queryKey: ["dashboard", "github", "connection-probe"],
    queryFn: () =>
      api<GithubProbeResponse>(
        "/api/dashboard/github/repos?page=1&per_page=1",
        { method: "GET" },
      ),
    refetchOnWindowFocus: false,
    retry: false,
  });

  const githubState: ConnectionState = github.isLoading
    ? "unknown"
    : github.isSuccess
      ? "connected"
      : github.error instanceof ApiError && github.error.status === 412
        ? "disconnected"
        : "unknown";

  // Set of configured adapter ids/slugs (for connection badges).
  const configuredIds = React.useMemo<ReadonlySet<string>>(() => {
    const out = new Set<string>();
    for (const row of adaptersQuery.data?.adapters ?? []) {
      out.add(row.id);
      out.add(row.slug);
    }
    return out;
  }, [adaptersQuery.data]);

  // Show "Start here" banner when both queries have settled and nothing
  // is connected (no YAML adapters and GitHub not authed).
  const cardsSettled =
    !adaptersQuery.isLoading &&
    !adaptersQuery.isError &&
    !github.isLoading;
  const noneConnected =
    cardsSettled &&
    (adaptersQuery.data?.adapters.length ?? 0) === 0 &&
    githubState !== "connected";

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["dashboard", "adapters"] });

  const configuredAdapters = adaptersQuery.data?.adapters ?? [];
  const hasConfigured = configuredAdapters.length > 0;

  return (
    <main className="flex-1 space-y-6 p-6">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Plug className="size-5" />
          Adapters
        </h1>
        <p className="text-sm text-muted-foreground">
          Sources Cortex can ingest from. Connect one to start building your
          knowledge base.
        </p>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* First-run "Start here" banner                                       */}
      {/* ------------------------------------------------------------------ */}
      {noneConnected && (
        <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          <p className="font-medium">Start here</p>
          <p className="mt-0.5 text-muted-foreground">
            Pick a source below and click <strong>Connect</strong> to start
            ingesting. GitHub is the fastest path — click{" "}
            <strong>Connect with GitHub</strong> to authorize with a single
            sign-in.
          </p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Connector cards grid                                                */}
      {/* ------------------------------------------------------------------ */}
      {adaptersQuery.isLoading || github.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <Card key={i} className="flex h-full flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-8 rounded-md" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                  <Skeleton className="h-5 w-20 rounded-md" />
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="mt-auto h-8 w-20 rounded-md" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CONNECTORS.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              state={
                connector.id === "github"
                  ? githubState
                  : configuredIds.has(connector.id)
                    ? "connected"
                    : "disconnected"
              }
              subtitle={
                connector.id === "github" && githubState === "connected"
                  ? MODE_SUBTITLES[github.data?.adapterMode ?? "dossier"]
                  : undefined
              }
              onOpenGuide={() => setActiveConnector(connector)}
            />
          ))}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Ops table — only when adapters are configured                       */}
      {/* ------------------------------------------------------------------ */}
      {hasConfigured && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Configured adapters</CardTitle>
          </CardHeader>
          <CardContent>
            {adaptersQuery.isError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                Failed to load adapters: {String(adaptersQuery.error)}
              </div>
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
                    {configuredAdapters.map((row) => (
                      <AdapterOpsRow
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
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Setup dialog                                                        */}
      {/* ------------------------------------------------------------------ */}
      <Dialog
        open={activeConnector !== null}
        onOpenChange={(open) => {
          if (!open) setActiveConnector(null);
        }}
      >
        {activeConnector ? (
          <ConnectorSetupDialog
            connector={activeConnector}
            onDone={() => {
              setActiveConnector(null);
              invalidate();
            }}
          />
        ) : null}
      </Dialog>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Connector card
// ---------------------------------------------------------------------------

interface ConnectorCardProps {
  connector: ConnectorDef;
  state: ConnectionState;
  subtitle?: string | undefined;
  onOpenGuide: () => void;
}

function ConnectorCard(props: ConnectorCardProps): React.ReactElement {
  const { connector, state, subtitle, onOpenGuide } = props;
  const [, navigate] = useLocation();
  const Icon = CONNECTOR_ICONS[connector.id] ?? Layers;

  const primaryAction = (() => {
    if (connector.id === "github") {
      if (state === "connected") {
        return (
          <Button
            type="button"
            size="sm"
            onClick={() => navigate("/integrations/github")}
          >
            Manage repos
          </Button>
        );
      }
      return (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => navigate("/login")}
        >
          <Github className="size-4" />
          Connect with GitHub
        </Button>
      );
    }
    return (
      <Button
        type="button"
        size="sm"
        variant={state === "connected" ? "outline" : "default"}
        onClick={onOpenGuide}
      >
        {state === "connected" ? "Reconfigure" : "Connect"}
      </Button>
    );
  })();

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-content-center rounded-md bg-muted text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <div className="flex flex-col">
              <CardTitle className="text-base">{connector.name}</CardTitle>
              {subtitle ? (
                <span className="text-[11px] text-muted-foreground">
                  {subtitle}
                </span>
              ) : null}
            </div>
          </div>
          <ConnectionBadge state={state} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-3">
        <p className="text-sm text-muted-foreground">{connector.description}</p>
        <div className="flex items-center justify-between gap-2">
          {primaryAction}
          <button
            type="button"
            onClick={onOpenGuide}
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            View setup guide
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectionBadge(props: { state: ConnectionState }): React.ReactElement {
  switch (props.state) {
    case "connected":
      return <Badge variant="success">Connected ✓</Badge>;
    case "disconnected":
      return <Badge variant="muted">Not connected</Badge>;
    default:
      return <Badge variant="outline">…</Badge>;
  }
}

// ---------------------------------------------------------------------------
// Connector setup dialog (wizard)
// ---------------------------------------------------------------------------

interface ConnectorSetupDialogProps {
  connector: ConnectorDef;
  onDone: () => void;
}

function ConnectorSetupDialog(
  props: ConnectorSetupDialogProps,
): React.ReactElement {
  const { connector, onDone } = props;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const spec = useQuery<WizardSpec, ApiError>({
    queryKey: ["dashboard", "wizard", "spec", "adapter", connector.id],
    queryFn: () =>
      api<WizardSpec>(`/api/dashboard/wizard/spec/adapter/${connector.id}`),
    enabled: connector.id !== "github",
    refetchOnWindowFocus: false,
    retry: false,
  });

  const submit = useMutation({
    mutationFn: async (answers: Record<string, unknown>) => {
      try {
        return await api<{ ok: boolean }>("/api/dashboard/wizard/run", {
          method: "POST",
          body: {
            moduleKind: "adapter",
            moduleId: connector.id,
            answers,
          },
        });
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.status === 400 &&
          err.body.errors
        ) {
          return { ok: false, errors: err.body.errors };
        }
        throw err;
      }
    },
    onSuccess: (result) => {
      if (result.ok) {
        queryClient.invalidateQueries({ queryKey: ["dashboard", "adapters"] });
        toast({
          title: `${connector.name} connected`,
          description: "Cortex will start ingesting on the next scheduled run.",
        });
        onDone();
      }
    },
  });

  const markdownHtml = React.useMemo(
    () => renderMarkdown(connector.setupMarkdown),
    [connector.setupMarkdown],
  );

  return (
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{connector.name} setup</DialogTitle>
        <DialogDescription>{connector.description}</DialogDescription>
      </DialogHeader>
      <div
        className="prose prose-sm dark:prose-invert max-w-none [&_a]:text-primary [&_a]:underline-offset-4 hover:[&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-muted-foreground [&_li]:my-1 [&_ol]:ml-5 [&_ol]:list-decimal [&_p]:text-sm [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-xs [&_ul]:ml-5 [&_ul]:list-disc"
        dangerouslySetInnerHTML={{ __html: markdownHtml }}
      />
      {connector.id === "github" ? (
        <p className="text-sm text-muted-foreground">
          Use the login screen's <strong>Continue with GitHub</strong> button
          to connect — no wizard required.
        </p>
      ) : spec.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading wizard…</p>
      ) : spec.isError || !spec.data ? (
        <p className="text-sm text-destructive">
          Couldn't load the wizard for {connector.name}:{" "}
          {String(spec.error?.message ?? "unknown error")}
        </p>
      ) : (
        <WizardForm
          spec={spec.data}
          submitLabel={`Save ${connector.name}`}
          onSubmit={async (answers) => {
            const result = await submit.mutateAsync(answers);
            if (result && !result.ok && "errors" in result) {
              return { errors: result.errors as Record<string, string> };
            }
          }}
          onCancel={onDone}
        />
      )}
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------
// Ops table row
// ---------------------------------------------------------------------------

function AdapterOpsRow(props: {
  row: AdapterRow;
  onChanged: () => void;
}) {
  const { row, onChanged } = props;
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const action = useMutation({
    mutationFn: async (act: "pause" | "resume" | "trigger-fetch") => {
      setBusy(true);
      try {
        await api(`/api/dashboard/adapters/${row.id}/${act}`, {
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
                  This will delete the adapter from cortex.yaml and remove its
                  declared secrets from .env. Memory already ingested through
                  this adapter stays in place.
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

// Keep the slim AdapterIdRow type exported so ConnectorsPage.tsx can
// reuse it if it still exists as a redirect shim. Currently unused but
// avoids a stale-import error if there are other callers.
export type { AdapterIdRow, AdaptersIdResponse };
