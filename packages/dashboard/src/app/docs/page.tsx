import Link from "next/link";
import { ArrowRight, FolderOpen } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { fetchCortexJsonServer } from "@/lib/api";

import { DOC_INDEX, type WorkspaceDocsList } from "./_lib";

export const dynamic = "force-dynamic";

export default async function DocsIndexPage(): Promise<React.JSX.Element> {
  let workspaceDocs: WorkspaceDocsList | undefined;
  let workspaceError: string | undefined;
  try {
    workspaceDocs = await fetchCortexJsonServer<WorkspaceDocsList>(
      "/api/workspace-docs",
    );
  } catch (e) {
    workspaceError = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Docs</h1>
        <p className="text-sm text-muted-foreground">
          Cortex stack reference + per-workspace runbooks. Reference is
          shared across every workspace; workspace docs follow whichever
          one is active.
        </p>
      </header>

      <section className="space-y-3">
        <SectionHeader
          title="Workspace docs"
          subtitle={
            workspaceDocs?.workspace
              ? `Reading from \`${workspaceDocs.path}\` for workspace \`${workspaceDocs.workspace}\`.`
              : "No workspace bound to this dashboard yet."
          }
        />

        {workspaceError ? (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardHeader>
              <CardTitle className="text-sm text-destructive">
                Couldn&apos;t reach the Cortex API
              </CardTitle>
              <CardDescription>{workspaceError}</CardDescription>
            </CardHeader>
          </Card>
        ) : !workspaceDocs?.workspace ? (
          <EmptyCard
            title="No workspace bound"
            body="Pick a workspace from the sidebar (or run `cortex workspace switch <slug>`) — workspace-specific docs follow whichever one is active."
          />
        ) : !workspaceDocs.exists ? (
          <EmptyCard
            title="No workspace docs yet"
            body={
              <>
                Drop markdown files into{" "}
                <code className="font-mono text-xs">
                  {workspaceDocs.path}
                </code>{" "}
                — they&apos;ll show up here. Each file&apos;s title comes
                from frontmatter or the first heading.
              </>
            }
          />
        ) : workspaceDocs.docs.length === 0 ? (
          <EmptyCard
            title="docs/ exists but is empty"
            body={
              <>
                Add a <code className="font-mono text-xs">.md</code> file
                under{" "}
                <code className="font-mono text-xs">
                  {workspaceDocs.path}
                </code>{" "}
                to get started.
              </>
            }
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {workspaceDocs.docs.map((doc) => (
              <li key={doc.slug}>
                <Link
                  href={`/docs/workspace/${encodeURIComponent(doc.slug)}`}
                  className="group block"
                >
                  <Card className="h-full transition group-hover:border-primary/40">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-3">
                        <CardTitle className="text-base">{doc.title}</CardTitle>
                        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
                      </div>
                      {doc.description && (
                        <CardDescription>{doc.description}</CardDescription>
                      )}
                    </CardHeader>
                    <CardContent className="text-xs text-muted-foreground">
                      <span className="font-mono">{doc.slug}.md</span>
                      <span className="ml-2">
                        {formatRelativeDate(doc.updatedAt)}
                      </span>
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Reference"
          subtitle="Cortex stack docs — same content as the docs/ folder in the cortex repo."
        />
        <ul className="grid gap-3 md:grid-cols-2">
          {DOC_INDEX.map((doc) => (
            <li key={doc.slug}>
              <Link href={`/docs/${doc.slug}`} className="group block">
                <Card className="h-full transition group-hover:border-primary/40">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <CardTitle className="text-base">{doc.title}</CardTitle>
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
                    </div>
                    {doc.description && (
                      <CardDescription>{doc.description}</CardDescription>
                    )}
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    <span className="font-mono">{doc.slug}.md</span>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}): React.JSX.Element {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function EmptyCard({
  title,
  body,
}: {
  title: string;
  body: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = Date.now() - d.getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
