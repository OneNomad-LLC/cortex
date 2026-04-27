import Link from "next/link";
import { ArrowRight } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { DOC_INDEX } from "./_lib";

export const dynamic = "force-dynamic";

export default function DocsIndexPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Docs</h1>
        <p className="text-sm text-muted-foreground">
          Setup, daily-use, and architecture reference. Same content as the{" "}
          <code className="font-mono text-xs">docs/</code> folder in the
          cortex repo — rendered here so you don&apos;t have to leave the
          dashboard.
        </p>
      </header>
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
    </div>
  );
}
