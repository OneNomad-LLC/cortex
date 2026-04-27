"use client";

import * as React from "react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Eye,
  FilePlus,
  FileText,
  RefreshCw,
  Search as SearchIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

import { invokeNoteTool, type NoteSummary } from "./lib/mcp";

interface NoteListResponse {
  notes: NoteSummary[];
}

export function NotesPanel(): React.JSX.Element {
  const [notes, setNotes] = useState<NoteSummary[] | undefined>();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await invokeNoteTool<NoteListResponse>("note_list", {});
      setNotes(result.notes);
      setError(undefined);
      setUnavailable(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not registered|404/i.test(msg)) {
        setUnavailable(true);
      } else {
        setError(msg);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!notes) return undefined;
    const q = filter.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) =>
      [n.title, n.preview, n.project ?? "", (n.tags ?? []).join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [notes, filter]);

  if (unavailable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes are not configured yet</CardTitle>
          <CardDescription>
            The <code className="font-mono">note_*</code> MCP tools aren&apos;t
            registered. To enable Notes:
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            1. Configure the obsidian adapter under{" "}
            <code className="font-mono">/adapters</code> with a vault path.
          </p>
          <p>
            2. Wait for the cortex-side notes module to ship — see thread #
            <code className="font-mono">cortex-notes-phase1</code>. Until that
            lands you can still create notes by writing markdown directly to{" "}
            <code className="font-mono">&lt;vault&gt;/cortex-notes/</code>.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardTitle className="text-base">Couldn&apos;t load notes</CardTitle>
          <CardDescription className="text-destructive">
            {error}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter notes by title, body, project, or tag…"
            className="pl-9"
          />
        </div>
        <Button asChild>
          <Link href="/notes/new">
            <FilePlus className="h-3.5 w-3.5" />
            New note
          </Link>
        </Button>
      </div>

      {!filtered ? (
        <ListSkeletons />
      ) : filtered.length === 0 ? (
        <EmptyState filtered={filter.length > 0} />
      ) : (
        <ul className="space-y-2">
          {filtered.map((n) => (
            <li key={n.id}>
              <NoteCard note={n} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ListSkeletons(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }): React.JSX.Element {
  if (filtered) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No matches</CardTitle>
          <CardDescription>
            Nothing in this workspace matches your filter.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">No notes yet</CardTitle>
        <CardDescription>
          This view shows everything in your Obsidian vault — both notes
          you create here (saved to{" "}
          <code className="font-mono text-xs">cortex-notes/</code>) and
          notes you author in Obsidian directly. All indexed automatically
          for search.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link href="/notes/new">
            <FilePlus className="h-3.5 w-3.5" />
            Create your first note
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function NoteCard({ note }: { note: NoteSummary }): React.JSX.Element {
  const Icon = note.kind === "obsidian" ? Eye : FileText;
  const href = noteHref(note);
  return (
    <Link href={href} className="group block">
      <Card className="transition group-hover:border-primary/40">
        <CardContent className="space-y-2 p-4">
          <div className="flex items-baseline gap-2">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">{note.title}</span>
            {note.kind === "obsidian" && (
              <Badge
                variant="outline"
                className="text-[10px] uppercase tracking-wider"
              >
                obsidian
              </Badge>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {formatRelativeDate(note.updated)}
            </span>
          </div>
          {note.preview && (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {note.preview}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {note.project && (
              <Badge variant="outline" className="text-[10px]">
                {note.project}
              </Badge>
            )}
            {(note.tags ?? []).map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px]">
                #{t}
              </Badge>
            ))}
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {note.slug ?? note.relativePath}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function noteHref(note: NoteSummary): string {
  if (note.kind === "cortex" && note.slug) {
    return `/notes/cortex/${encodeURIComponent(note.slug)}`;
  }
  // Obsidian: split on `/` so each segment is a separate route param;
  // strip the trailing `.md` since the page reattaches it.
  const path = (note.relativePath ?? note.id).replace(/\.md$/i, "");
  const segments = path.split("/").map(encodeURIComponent).join("/");
  return `/notes/obsidian/${segments}`;
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
