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
  Plug,
  Trello,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, api } from "@/lib/api";
import { CONNECTORS, type ConnectorDef } from "@/lib/connectors";
import { renderMarkdown } from "@/lib/markdown";
import { WizardForm, type WizardSpec } from "@/components/wizard";
import { useToast } from "@/components/ui/toast";

/**
 * Connectors directory — a single page that lists every source Cortex
 * can ingest from, marks which are currently configured, and surfaces
 * setup steps inline.
 *
 * Connection-status sources, in priority order:
 *
 *   - **GitHub**: probed via `GET /api/dashboard/github/repos` because
 *     OAuth tokens live on the session, not in the YAML adapter list.
 *     200 → connected; 412 `github_not_connected` → not connected;
 *     any other error → unknown.
 *   - **Everything else**: the YAML adapter list at
 *     `GET /api/dashboard/adapters`. Match by `id` (or `slug`).
 *
 * Clicking a connector opens a modal that renders the embedded
 * `SETUP.md` above the existing `<WizardForm>` for that adapter. The
 * wizard reuses the same submit endpoint as the standalone Add Adapter
 * page; on success we invalidate both queries so the badge flips to
 * "Connected" without a manual refresh.
 */

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

interface AdapterRow {
  id: string;
  slug: string;
  name: string;
}

interface AdaptersResponse {
  adapters: AdapterRow[];
}

type ConnectionState = "connected" | "disconnected" | "unknown";

type RepoMode = "dossier" | "full" | "both";

interface GithubProbeResponse {
  adapterMode?: RepoMode | null;
  /** Other fields exist on this response but the Connectors page only
   *  uses adapterMode. Treat as opaque. */
  [key: string]: unknown;
}

const MODE_SUBTITLES: Record<RepoMode, string> = {
  dossier: "Dossier mode (recommended)",
  full: "Full source mode",
  both: "Both modes",
};

export function ConnectorsPage(): React.ReactElement {
  const [activeConnector, setActiveConnector] =
    React.useState<ConnectorDef | null>(null);

  // YAML-configured adapters drive the "Connected" badge for every
  // connector except GitHub.
  const adapters = useQuery<AdaptersResponse>({
    queryKey: ["dashboard", "adapters"],
    queryFn: () => api<AdaptersResponse>("/api/dashboard/adapters"),
    refetchOnWindowFocus: false,
  });

  // GitHub gets a dedicated probe because its connection lives on the
  // dashboard session (an OAuth token), not in cortex.yaml. We only
  // need the response status, so request page=1 per_page=1 to keep it
  // cheap. The response also carries `adapterMode` (Slice D), which
  // drives the per-card subtitle on the GitHub connector.
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

  const configuredIds = React.useMemo(() => {
    const out = new Set<string>();
    for (const row of adapters.data?.adapters ?? []) {
      out.add(row.id);
      out.add(row.slug);
    }
    return out;
  }, [adapters.data]);

  return (
    <main className="flex-1 space-y-4 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Plug className="size-5" />
          Connectors
        </h1>
        <p className="text-sm text-muted-foreground">
          Sources Cortex can ingest from. Pick one to connect or view its
          setup guide.
        </p>
      </header>

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

      <Dialog
        open={activeConnector !== null}
        onOpenChange={(open) => {
          if (!open) setActiveConnector(null);
        }}
      >
        {activeConnector ? (
          <ConnectorSetupDialog
            connector={activeConnector}
            onDone={() => setActiveConnector(null)}
          />
        ) : null}
      </Dialog>
    </main>
  );
}

interface ConnectorCardProps {
  connector: ConnectorDef;
  state: ConnectionState;
  /**
   * Optional supplementary line under the title. Used by the GitHub
   * card to surface adapter-level mode ("Dossier mode (recommended)")
   * once the connection is live. Other connectors omit this today.
   */
  subtitle?: string | undefined;
  onOpenGuide: () => void;
}

function ConnectorCard(props: ConnectorCardProps): React.ReactElement {
  const { connector, state, subtitle, onOpenGuide } = props;
  const [, navigate] = useLocation();
  const Icon = CONNECTOR_ICONS[connector.id] ?? Layers;

  const primaryAction = (() => {
    // GitHub gets dedicated CTAs because its connection isn't a wizard.
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

function ConnectionBadge(props: {
  state: ConnectionState;
}): React.ReactElement {
  switch (props.state) {
    case "connected":
      return <Badge variant="success">Connected ✓</Badge>;
    case "disconnected":
      return <Badge variant="muted">Not connected</Badge>;
    default:
      return <Badge variant="outline">…</Badge>;
  }
}

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

  // Fetch the wizard spec on demand — only when the dialog opens. The
  // catalog already enforces uniqueness so the cache key is stable.
  const spec = useQuery<WizardSpec, ApiError>({
    queryKey: ["dashboard", "wizard", "spec", "adapter", connector.id],
    queryFn: () =>
      api<WizardSpec>(
        `/api/dashboard/wizard/spec/adapter/${connector.id}`,
      ),
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
        queryClient.invalidateQueries({
          queryKey: ["dashboard", "adapters"],
        });
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
          Use the login screen's <strong>Continue with GitHub</strong>{" "}
          button to connect — no wizard required.
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
