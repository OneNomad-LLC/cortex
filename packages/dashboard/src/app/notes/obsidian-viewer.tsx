"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { invokeNoteTool, type NoteRead } from "./lib/mcp";

interface ObsidianViewerProps {
  relativePath: string;
}

export function ObsidianViewer({
  relativePath,
}: ObsidianViewerProps): React.JSX.Element {
  const router = useRouter();
  const [note, setNote] = useState<NoteRead | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invokeNoteTool<NoteRead>("note_get", {
          relativePath,
        });
        if (!cancelled) setNote(result);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relativePath]);

  return (
    <div className="flex min-h-[calc(100vh-3rem)] flex-col">
      <header className="flex items-center justify-between gap-4 border-b pb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/notes")}
          className="text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to notes
        </Button>
        <div className="flex items-center gap-2">
          <code className="font-mono text-xs text-muted-foreground">
            {relativePath}
          </code>
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-wider"
          >
            obsidian · read-only
          </Badge>
        </div>
      </header>

      <div className="flex-1 py-6">
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            Couldn&apos;t load note. {error}
          </div>
        ) : !note ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : (
          <article className="space-y-4">
            <h1 className="text-3xl font-bold tracking-tight">{note.title}</h1>
            <div className="flex flex-wrap items-center gap-2">
              {note.project && (
                <Badge variant="outline" className="text-[10px]">
                  {note.project}
                </Badge>
              )}
              {(note.tags ?? []).map((t) => (
                <Badge
                  key={t}
                  variant="secondary"
                  className="text-[10px] font-normal"
                >
                  #{t}
                </Badge>
              ))}
              <span className="ml-auto text-xs text-muted-foreground">
                {new Date(note.updated).toLocaleString()}
              </span>
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none rounded-md border bg-card p-6">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {note.body}
              </ReactMarkdown>
            </div>
          </article>
        )}
      </div>

      <footer className="sticky bottom-0 -mx-6 mt-auto flex items-center justify-end gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <Button
          variant="outline"
          onClick={() => {
            const file = encodeURIComponent(relativePath);
            window.open(`obsidian://open?file=${file}`, "_blank");
          }}
        >
          <ExternalLink className="h-4 w-4" />
          Open in Obsidian
        </Button>
      </footer>
    </div>
  );
}
