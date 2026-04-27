import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { DOC_INDEX, readDoc } from "../_lib";
import { DocViewer } from "./doc-viewer";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function DocPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  const content = await readDoc(slug);
  if (content === undefined) notFound();

  const known = DOC_INDEX.find((d) => d.slug === slug);
  const title = known?.title ?? `${slug}.md`;
  const description = known?.description;

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
          <CardTitle className="text-2xl">{title}</CardTitle>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
          <p className="font-mono text-xs text-muted-foreground">
            docs/{slug}.md
          </p>
        </CardHeader>
        <CardContent>
          <DocViewer markdown={content} />
        </CardContent>
      </Card>
    </div>
  );
}
