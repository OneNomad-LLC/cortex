"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { NoteEditForm } from "../../note-edit-form";
import { invokeNoteTool, type NoteRead } from "../../lib/mcp";

export function CortexNoteEditor({
  slug,
}: {
  slug: string;
}): React.JSX.Element {
  const router = useRouter();
  const [note, setNote] = useState<NoteRead | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invokeNoteTool<NoteRead>("note_get", { slug });
        if (!cancelled) setNote(result);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (error) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/notes")}
          className="text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to notes
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

  return <NoteEditForm mode="edit" initial={note} />;
}
