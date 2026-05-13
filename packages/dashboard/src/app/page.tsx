import Link from "next/link";
import { Cable, Cpu, Wrench, Activity, ArrowUpRight } from "lucide-react";
import { fetchLayoutServer, fetchCortexJsonServer } from "@/lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WorkspaceSwitcher } from "@/widgets/workspace-switcher";

export const dynamic = "force-dynamic";

interface LayoutLike {
  workspace?: string | null;
}

interface AdaptersListResp {
  adapters?: Array<{ id: string; enabled?: boolean }>;
}

interface ProvidersListResp {
  providers?: Array<{ id: string; enabled?: boolean }>;
}

/**
 * Operator overview. This dashboard is an admin surface (devops / IT for
 * on-prem installs; the operator for cloud), not an end-user UI. The
 * page surfaces the few things an operator actually does on visit:
 * confirm what workspace is active, see at a glance whether anything is
 * configured, and jump to the relevant config screen.
 *
 * No widget grid, no per-end-user "today" framing. If you want richer
 * health detail, /status is the canonical surface.
 */
export default async function Home(): Promise<React.JSX.Element> {
  const [layoutResult, adaptersResult, providersResult] = await Promise.all([
    fetchLayoutServer<LayoutLike>().catch(
      (err: unknown) =>
        ({ _error: err instanceof Error ? err.message : String(err) }) as {
          _error: string;
        },
    ),
    fetchCortexJsonServer<AdaptersListResp>("/api/adapters").catch(
      () => ({}) as AdaptersListResp,
    ),
    fetchCortexJsonServer<ProvidersListResp>("/api/providers").catch(
      () => ({}) as ProvidersListResp,
    ),
  ]);

  const layout = "_error" in layoutResult ? undefined : layoutResult;
  const layoutError = "_error" in layoutResult ? layoutResult._error : null;

  const adapterCount = adaptersResult.adapters?.length ?? 0;
  const enabledAdapters =
    adaptersResult.adapters?.filter((a) => a.enabled).length ?? 0;
  const providerCount = providersResult.providers?.length ?? 0;
  const enabledProviders =
    providersResult.providers?.filter((p) => p.enabled).length ?? 0;

  const configured = enabledAdapters > 0 || enabledProviders > 0;

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-text-disabled">
            {'// Operator overview'}
          </p>
          <h1 className="mt-2 font-mono text-2xl font-semibold tracking-tight text-text-primary">
            {layout?.workspace ? (
              <>
                Workspace <span className="text-gold">{layout.workspace}</span>
              </>
            ) : (
              "Cortex"
            )}
          </h1>
          <p className="mt-1 max-w-2xl font-body text-sm text-text-secondary">
            Admin surface for the running Cortex instance. Configure adapters
            and LLM providers, watch sync health, manage workspaces. End users
            never see this page — they call Cortex through their MCP client.
          </p>
        </div>
        <WorkspaceSwitcher
          {...(layout?.workspace ? { initialSlug: layout.workspace } : {})}
        />
      </header>

      {layoutError && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              Couldn&apos;t reach the Cortex API
            </CardTitle>
            <CardDescription>{layoutError}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-text-secondary">
            Is the cortex daemon running? Check{" "}
            <code className="font-mono text-xs text-text-primary">
              cortex status
            </code>{" "}
            or the daemon log.
          </CardContent>
        </Card>
      )}

      <section className="grid gap-5 md:grid-cols-3">
        <StatCard
          icon={Cpu}
          eyebrow="LLM providers"
          value={`${enabledProviders}/${providerCount}`}
          sub={
            enabledProviders === 0
              ? "None enabled — enrichment runs via the connected MCP client."
              : "Enabled / total"
          }
        />
        <StatCard
          icon={Cable}
          eyebrow="Adapters"
          value={`${enabledAdapters}/${adapterCount}`}
          sub={
            enabledAdapters === 0
              ? "Nothing ingesting yet."
              : "Enabled / total"
          }
        />
        <StatCard
          icon={Activity}
          eyebrow="Status"
          value={configured ? "Running" : "Not configured"}
          sub={
            configured
              ? "See Status for live health."
              : "Run the setup wizard to enable ingestion."
          }
        />
      </section>

      <section>
        <h2 className="mb-4 font-mono text-[11px] uppercase tracking-widest text-text-muted">
          {configured ? "// Common admin tasks" : "// Get started"}
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          <ActionCard
            href="/setup"
            icon={Wrench}
            title="Setup wizard"
            description={
              configured
                ? "Re-run any module wizard."
                : "First-run config. Pick a provider, enable an adapter."
            }
          />
          <ActionCard
            href="/adapters"
            icon={Cable}
            title="Adapters"
            description="Connect Confluence, GitHub, Slack, Linear, Notion, Obsidian, and more."
          />
          <ActionCard
            href="/providers"
            icon={Cpu}
            title="LLM providers"
            description="Configure OpenRouter, Ollama, Anthropic, or any OpenAI-compatible endpoint."
          />
        </div>
      </section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  eyebrow,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  value: string;
  sub?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-border-subtle bg-bg-surface/40 p-6">
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-text-muted">
        <Icon className="h-3 w-3" />
        {eyebrow}
      </div>
      <div className="mt-3 font-mono text-2xl font-semibold capitalize text-text-primary">
        {value}
      </div>
      {sub && (
        <div className="mt-1 font-body text-xs text-text-secondary">{sub}</div>
      )}
    </div>
  );
}

function ActionCard({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-2 rounded-2xl border border-border-subtle bg-bg-surface/40 p-5 transition-colors hover:border-gold/40 hover:bg-bg-raised/40"
    >
      <div className="flex items-center justify-between">
        <Icon className="h-4 w-4 text-gold" />
        <ArrowUpRight className="h-3 w-3 text-text-muted transition-colors group-hover:text-gold" />
      </div>
      <h3 className="font-mono text-sm font-semibold text-text-primary">
        {title}
      </h3>
      <p className="font-body text-xs leading-relaxed text-text-secondary">
        {description}
      </p>
    </Link>
  );
}
