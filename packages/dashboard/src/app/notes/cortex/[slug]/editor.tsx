"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, ExternalLink, Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { NoteEditForm } from "../../note-edit-form";
import { invokeNoteTool, type NoteRead } from "../../lib/mcp";

type Mode = "view" | "edit";

export function CortexNoteEditor({
  slug,
}: {
  slug: string;
}): React.JSX.Element {
  const router = useRouter();
  const [note, setNote] = useState<NoteRead | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [mode, setMode] = useState<Mode>("view");
  const [deleting, setDeleting] = useState(false);

  const loadNote = useCallback(async (): Promise<void> => {
    try {
      const result = await invokeNoteTool<NoteRead>("note_get", { slug });
      setNote(result);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [slug]);

  useEffect(() => {
    void loadNote();
  }, [loadNote]);

  if (error) {
    return (
      <div className="space-y-4">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
        >
          <Link href="/notes">
            <ArrowLeft className="h-4 w-4" />
            Back to notes
          </Link>
        </Button>
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Couldn&apos;t load note. {error}
        </div>
      </div>
    );
  }

  if (!note) {
    return (
      <div className="space-y-4 py-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (mode === "edit") {
    return (
      <NoteEditForm
        mode="edit"
        initial={note}
        onSaved={async () => {
          await loadNote();
          setMode("view");
        }}
        onCancel={() => setMode("view")}
        onDeleted={() => {
          router.push("/notes");
          router.refresh();
        }}
      />
    );
  }

  async function handleDelete(): Promise<void> {
    if (!note || deleting) return;
    if (!window.confirm(`Delete "${note.title}"? This cannot be undone.`))
      return;
    setDeleting(true);
    try {
      await invokeNoteTool("note_delete", { slug: note.id });
      toast.success(`Deleted ${note.title}`);
      router.push("/notes");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-3rem)] flex-col">
      <header className="flex items-center justify-between gap-4 border-b pb-4">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
        >
          <Link href="/notes">
            <ArrowLeft className="h-4 w-4" />
            Back to notes
          </Link>
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <code className="font-mono">{note.relativePath}</code>
        </div>
      </header>

      <article className="flex-1 space-y-4 py-6">
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
            Updated {new Date(note.updated).toLocaleString()}
          </span>
        </div>
        <div className="prose prose-sm dark:prose-invert max-w-none rounded-md border bg-card p-6">
          {note.body.trim().length === 0 ? (
            <p className="text-muted-foreground">
              This note is empty. Click <em>Edit</em> to add content.
            </p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {note.body}
            </ReactMarkdown>
          )}
        </div>
      </article>

      <footer className="sticky bottom-0 -mx-6 mt-auto flex items-center justify-between gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <Button
          variant="ghost"
          onClick={() => void handleDelete()}
          disabled={deleting}
          className="text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-4 w-4" />
          {deleting ? "Deleting…" : "Delete"}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              const file = encodeURIComponent(note.relativePath);
              window.open(`obsidian://open?file=${file}`, "_blank");
            }}
          >
            <ExternalLink className="h-4 w-4" />
            Open in Obsidian
          </Button>
          <Button onClick={() => setMode("edit")}>
            <Pencil className="h-4 w-4" />
            Edit
          </Button>
        </div>
      </footer>
    </div>
  );
}
