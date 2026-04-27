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
import { type ResolvedLayout, renderWidget } from "@/widgets/registry";
import { WorkspaceSwitcher } from "@/widgets/workspace-switcher";

export const dynamic = "force-dynamic";

export default async function Home(): Promise<React.JSX.Element> {
  let layout: ResolvedLayout | undefined;
  let error: string | undefined;
  try {
    layout = await fetchLayoutServer<ResolvedLayout>();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-6">
      <AutoRefresh intervalMs={15_000} />
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Your work-knowledge at a glance. Refreshes every 15s.
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

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              Couldn&apos;t reach the Cortex API
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            Is <code className="font-mono">cortex</code> running?
            Try <code className="font-mono">docker compose ps</code>.
          </CardContent>
        </Card>
      )}

      {layout && (
        <div className="grid gap-4 lg:grid-cols-2">
          {layout.widgets.map((w) => (
            <div key={w.name}>{renderWidget(w, layout.workspace)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
