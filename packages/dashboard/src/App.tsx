import { Route, Switch } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AdaptersListPage } from "@/pages/AdaptersListPage";
import { AdapterAddPage } from "@/pages/AdapterAddPage";
import { AdapterDetailPage } from "@/pages/AdapterDetailPage";

/**
 * Top-level route table. The shell teammate owns `<AppShell>`,
 * `LoginPage`, and the workspace switcher; this file only owns the
 * route entries pointing at pages each teammate built. Lead reconciles
 * the AppShell wrapper at merge time.
 *
 * Today the dashboard SPA wouldn't have an AppShell yet (shell branch
 * lands separately), so each page returns its own `<main>`. When the
 * shell wrapper lands, the route components become children of the
 * shell layout and the placeholder home card here goes away.
 */
export default function App() {
  return (
    <Switch>
      <Route path="/adapters" component={AdaptersListPage} />
      <Route path="/adapters/new" component={AdapterAddPage} />
      <Route path="/adapters/:id" component={AdapterDetailPage} />
      <Route>
        <DashboardHome />
      </Route>
    </Switch>
  );
}

function DashboardHome() {
  return (
    <main className="flex min-h-full items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Cortex Dashboard</CardTitle>
          <CardDescription>
            Phase 2 — adapters, wizards, ops landing in parallel branches.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Try{" "}
            <a className="underline" href="/_dashboard/adapters">
              /_dashboard/adapters
            </a>{" "}
            to manage source connectors.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
