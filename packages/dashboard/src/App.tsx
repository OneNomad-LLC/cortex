import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Phase 0 placeholder. Real dashboard pages (Status, Adapters, Workspaces,
 * MCP console, Wizards, etc.) get wired in via wouter on top of this
 * shell in subsequent phases. The intent here is purely to prove the
 * Vite build pipeline + static serving + Tailwind tokens work end to end.
 */
export default function App() {
  return (
    <main className="flex min-h-full items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Cortex Dashboard</CardTitle>
          <CardDescription>
            Phase 0 scaffold — coming online
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The dashboard SPA is served by the Cortex HTTP sidecar under{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              /_dashboard
            </code>
            . Authentication, the wizard runner, and full pages land in
            later phases.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
