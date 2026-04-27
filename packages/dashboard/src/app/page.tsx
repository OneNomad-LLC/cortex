import { fetchLayoutServer, fetchWidgetServer } from "@/lib/api";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TodayTimeline, type TodayTimelineOutput } from "@/widgets/today-timeline";
import { WorkspaceSwitcher } from "@/widgets/workspace-switcher";
import type { ResolvedLayout } from "@/widgets/registry";

export const dynamic = "force-dynamic";

interface FetchError {
  source: "layout" | "timeline";
  message: string;
}

export default async function Home(): Promise<React.JSX.Element> {
  // Two parallel fetches: layout (workspace + role badge) and the timeline
  // payload itself. Either failing degrades gracefully — the page still
  // renders the side that succeeded.
  const [layoutResult, timelineResult] = await Promise.allSettled([
    fetchLayoutServer<ResolvedLayout>(),
    fetchWidgetServer<TodayTimelineOutput>("today-timeline"),
  ]);

  const layout = layoutResult.status === "fulfilled" ? layoutResult.value : undefined;
  const timeline = timelineResult.status === "fulfilled" ? timelineResult.value : undefined;
  const errors: FetchError[] = [];
  if (layoutResult.status === "rejected") {
    errors.push({
      source: "layout",
      message: layoutResult.reason instanceof Error
        ? layoutResult.reason.message
        : String(layoutResult.reason),
    });
  }
  if (timelineResult.status === "rejected") {
    errors.push({
      source: "timeline",
      message: timelineResult.reason instanceof Error
        ? timelineResult.reason.message
        : String(timelineResult.reason),
    });
  }

  return (
    <div className="space-y-6">
      <AutoRefresh intervalMs={15_000} />
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today</h1>
          <p className="text-sm text-muted-foreground">
            What needs your attention right now. Refreshes every 15s. Widget grid lives at
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

      {errors.length > 0 && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              Couldn&apos;t reach the Cortex API
            </CardTitle>
            <CardDescription>
              {errors.map((e) => `${e.source}: ${e.message}`).join(" · ")}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            Is <code className="font-mono">cortex</code> running?
            Try <code className="font-mono">docker compose ps</code>.
          </CardContent>
        </Card>
      )}

      {timeline && <TodayTimeline data={timeline} />}
    </div>
  );
}
