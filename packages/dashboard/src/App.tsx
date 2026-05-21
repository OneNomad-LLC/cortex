import { Route, Switch, Link } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ToastProvider } from "@/components/ui/toast";
import LogsPage from "@/pages/LogsPage";
import JobsPage from "@/pages/JobsPage";
import StatsPage from "@/pages/StatsPage";
import IngestPage from "@/pages/IngestPage";

/**
 * Phase 0 root. Real shell (sidebar, header, auth gate, workspace
 * switcher) lands in the Shell teammate's slice — this file currently
 * just wires the routes the Ops slice owns so a fresh build can hit
 * `/logs`, `/jobs`, `/stats`, `/ingest`. The lead resolves merge
 * conflicts with the Shell-side App.tsx at integration time.
 *
 * Routes registered:
 *   /         — home placeholder
 *   /logs     — runtime log tail
 *   /jobs     — background ingest jobs
 *   /stats    — KB size + per-source counts
 *   /ingest   — URL / file / raw-content ingest forms
 */
export default function App() {
  return (
    <ToastProvider>
      <main className="min-h-full bg-background text-foreground">
        <nav className="flex items-center gap-4 border-b px-6 py-3 text-sm">
          <Link href="/" className="font-semibold tracking-tight">
            Cortex
          </Link>
          <Link href="/stats" className="text-muted-foreground hover:text-foreground">
            Stats
          </Link>
          <Link href="/jobs" className="text-muted-foreground hover:text-foreground">
            Jobs
          </Link>
          <Link href="/logs" className="text-muted-foreground hover:text-foreground">
            Logs
          </Link>
          <Link href="/ingest" className="text-muted-foreground hover:text-foreground">
            Ingest
          </Link>
        </nav>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/logs" component={LogsPage} />
          <Route path="/jobs" component={JobsPage} />
          <Route path="/stats" component={StatsPage} />
          <Route path="/ingest" component={IngestPage} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </ToastProvider>
  );
}

function Home() {
  return (
    <div className="flex min-h-[calc(100vh-3rem)] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Cortex Dashboard</CardTitle>
          <CardDescription>
            Knowledge-base ops surface
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Pick a section: <Link href="/stats" className="underline">Stats</Link>,{" "}
          <Link href="/jobs" className="underline">Jobs</Link>,{" "}
          <Link href="/logs" className="underline">Logs</Link>, or{" "}
          <Link href="/ingest" className="underline">Ingest</Link>.
        </CardContent>
      </Card>
    </div>
  );
}

function NotFound() {
  return (
    <div className="p-6 text-sm text-muted-foreground">
      Page not found. <Link href="/" className="underline">Back to home</Link>.
    </div>
  );
}
