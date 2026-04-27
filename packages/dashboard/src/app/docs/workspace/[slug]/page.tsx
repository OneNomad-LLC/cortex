import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchCortexJsonServer } from "@/lib/api";

import { DocViewer } from "../../[slug]/doc-viewer";
import { type WorkspaceDocRead } from "../../_lib";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function WorkspaceDocPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  let doc: WorkspaceDocRead;
  try {
    doc = await fetchCortexJsonServer<WorkspaceDocRead>(
      `/api/workspace-docs/${encodeURIComponent(slug)}`,
    );
  } catch {
    notFound();
  }

  return (
    <div className="space-y-4">
      <Link
        href="/docs"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-3 w-3" />
        All docs
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{doc.title}</CardTitle>
          <p className="font-mono text-xs text-muted-foreground">
            {doc.path}
          </p>
          <p className="text-xs text-muted-foreground">
            workspace · {doc.workspace} · updated{" "}
            {new Date(doc.updatedAt).toLocaleString()}
          </p>
        </CardHeader>
        <CardContent>
          <DocViewer markdown={doc.body} />
        </CardContent>
      </Card>
    </div>
  );
}
