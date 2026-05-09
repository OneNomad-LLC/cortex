import { fetchLayoutServer } from "@/lib/api";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecentActivityWidget } from "@/widgets/recent-activity";
import { WorkspaceSwitcher } from "@/widgets/workspace-switcher";
import type { ResolvedLayout } from "@/widgets/registry";

export const dynamic = "force-dynamic";

/**
 * Dashboard root.
 *
 * Knowledge-engine repositioning (Phase 1B, 2026-05-09): the prior
 * TodayTimeline aggregation (meetings + priorities + decisions) was a
 * personal-priority surface that didn't fit Cortex's multi-tenant
 * org-knowledge framing. Replaced with a focused "Recent activity"
 * card pointed at the org's last 7 days of ingested content. The
 * widget grid at /widgets remains the configurable surface for users
 * who want a richer view; this page is the one-glance landing.
 */
export default async function Home(): Promise<React.JSX.Element> {
  // Fetch the layout for the workspace + role badge. The
  // RecentActivityWidget itself is a Server Component that does its
  // own fetch + error rendering — we don't need to parallel-fetch
  // here.
  const layoutResult = await fetchLayoutServer<ResolvedLayout>().catch(
    (err: unknown) => ({
      _error: err instanceof Error ? err.message : String(err),
    } as { _error: string }),
  );
  const layout = "_error" in layoutResult ? undefined : layoutResult;
  const layoutError = "_error" in layoutResult ? layoutResult._error : null;

  return (
    <div className="space-y-6">
      <AutoRefresh intervalMs={15_000} />
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Knowledge</h1>
          <p className="text-sm text-muted-foreground">
            Recent ingest activity for this workspace. Refreshes every 15s.
            Configurable widget grid at
            <code className="mx-1 font-mono text-xs">/widgets</code>.
          </p>
        </div>
        {layout && (
          <div className="flex items-center gap-3">
            <WorkspaceSwitcher
              {...(layout.workspace ? { initialSlug: layout.workspace } : {})}
            />
            <Badge variant="outline" className="font-mono text-[10px] uppercase">
              {layout.role}
            </Badge>
          </div>
        )}
      </header>

      {layoutError && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              Couldn&apos;t reach the Cortex API
            </CardTitle>
            <CardDescription>{layoutError}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            Is <code className="font-mono">cortex</code> running?
            Try <code className="font-mono">docker compose ps</code>.
          </CardContent>
        </Card>
      )}

      <RecentActivityWidget
        days={7}
        limit={20}
        {...(layout?.workspace ? { workspace: layout.workspace } : {})}
      />
    </div>
  );
}
