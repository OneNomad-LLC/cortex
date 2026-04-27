"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ExternalLink,
  Eye,
  FilePlus,
  FileText,
  RefreshCw,
  Save,
  Search as SearchIcon,
  Trash2,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

import { NoteEditor } from "./note-editor";

interface NoteSummary {
  id: string;
  slug?: string;
  title: string;
  project?: string;
  tags?: string[];
  updated: string;
  preview: string;
  kind: "cortex" | "obsidian";
  relativePath?: string;
}

interface NoteListResponse {
  notes: NoteSummary[];
}

async function invokeMcpTool<T>(
  name: string,
  input: Record<string, unknown>,
): Promise<T> {
  const r = await fetch(
    `/api/cortex/mcp/tools/${encodeURIComponent(name)}/invoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
  const body = (await r.json().catch(() => ({}))) as {
    result?: T;
    error?: string;
  };
  if (!r.ok) {
    throw new Error(body.error ?? `${r.status} ${r.statusText}`);
  }
  if (body.result === undefined) {
    throw new Error("missing result");
  }
  return body.result;
}

export function NotesPanel(): React.JSX.Element {
  const [notes, setNotes] = useState<NoteSummary[] | undefined>();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [unavailable, setUnavailable] = useState(false);
  const [editing, setEditing] = useState<NoteSummary | undefined>();
  const [viewing, setViewing] = useState<NoteSummary | undefined>();
  const [creating, setCreating] = useState(false);

  function openNote(note: NoteSummary): void {
    if (note.kind === "obsidian") {
      setViewing(note);
    } else {
      setEditing(note);
    }
  }

  const refresh = useCallback(async () => {
    try {
      const result = await invokeMcpTool<NoteListResponse>("note_list", {});
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
        <Button onClick={() => setCreating(true)}>
          <FilePlus className="h-3.5 w-3.5" />
          New note
        </Button>
      </div>

      {!filtered ? (
        <ListSkeletons />
      ) : filtered.length === 0 ? (
        <EmptyState filtered={filter.length > 0} onCreate={() => setCreating(true)} />
      ) : (
        <ul className="space-y-2">
          {filtered.map((n) => (
            <li key={n.id}>
              <NoteCard note={n} onClick={() => openNote(n)} />
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <NoteDialog
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}

      {editing && (
        <NoteDialog
          mode="edit"
          note={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await refresh();
          }}
          onDeleted={async () => {
            setEditing(undefined);
            await refresh();
          }}
        />
      )}

      {viewing && (
        <ObsidianNoteDialog
          note={viewing}
          onClose={() => setViewing(undefined)}
        />
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

function EmptyState({
  filtered,
  onCreate,
}: {
  filtered: boolean;
  onCreate: () => void;
}): React.JSX.Element {
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
        <Button onClick={onCreate}>
          <FilePlus className="h-3.5 w-3.5" />
          Create your first note
        </Button>
      </CardContent>
    </Card>
  );
}

function NoteCard({
  note,
  onClick,
}: {
  note: NoteSummary;
  onClick: () => void;
}): React.JSX.Element {
  const Icon = note.kind === "obsidian" ? Eye : FileText;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group block w-full text-left"
    >
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
    </button>
  );
}

interface DialogProps {
  mode: "create" | "edit";
  note?: NoteSummary;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted?: () => Promise<void>;
}

function NoteDialog({
  mode,
  note,
  onClose,
  onSaved,
  onDeleted,
}: DialogProps): React.JSX.Element {
  const [title, setTitle] = useState(note?.title ?? "");
  const [project, setProject] = useState(note?.project ?? "");
  const [tagsCsv, setTagsCsv] = useState((note?.tags ?? []).join(", "));
  const [body, setBody] = useState<string | undefined>();
  const [bodyLoading, setBodyLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Edit dialog only opens for cortex-kind notes. Pull the full body
  // via note_get; preview is fine for the listing but the editor
  // needs the real markdown source.
  useEffect(() => {
    if (mode === "edit" && note) {
      void (async () => {
        try {
          const result = await invokeMcpTool<{ body: string }>("note_get", {
            slug: note.slug,
          });
          setBody(result.body);
        } catch {
          setBody(note.preview);
        } finally {
          setBodyLoading(false);
        }
      })();
    } else {
      setBody("");
    }
  }, [mode, note]);

  async function save(): Promise<void> {
    if (!title.trim() || body === undefined) return;
    setSaving(true);
    try {
      const tags = tagsCsv
        .split(",")
        .map((s) => s.trim().replace(/^#/, ""))
        .filter((s) => s.length > 0);
      if (mode === "create") {
        await invokeMcpTool("note_create", {
          title: title.trim(),
          body,
          ...(project.trim() ? { project: project.trim() } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        });
        toast.success(`Note created: ${title}`);
      } else if (note) {
        await invokeMcpTool("note_update", {
          slug: note.slug,
          title: title.trim(),
          body,
          project: project.trim() || undefined,
          tags: tags.length > 0 ? tags : undefined,
        });
        toast.success(`Note saved: ${title}`);
      }
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function del(): Promise<void> {
    if (!note) return;
    if (!window.confirm(`Delete "${note.title}"? This cannot be undone.`))
      return;
    setDeleting(true);
    try {
      await invokeMcpTool("note_delete", { slug: note.slug });
      toast.success(`Deleted ${note.title}`);
      await onDeleted?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  const titleOk = title.trim().length > 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New note" : "Edit note"}
          </DialogTitle>
          <DialogDescription>
            Saved as markdown to{" "}
            <code className="font-mono text-xs">
              &lt;vault&gt;/cortex-notes/{note?.slug ?? "<slug>"}.md
            </code>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="note-title">Title</Label>
              <Input
                id="note-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="One-line headline"
                autoFocus={mode === "create"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="note-project">Project</Label>
              <Input
                id="note-project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="project-slug"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor="note-tags">Tags (csv)</Label>
              <Input
                id="note-tags"
                value={tagsCsv}
                onChange={(e) => setTagsCsv(e.target.value)}
                placeholder="comma, separated, tags"
              />
            </div>
          </div>

          {bodyLoading || body === undefined ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <NoteEditor initialMarkdown={body} onChange={setBody} />
          )}
        </div>

        <DialogFooter className="flex items-center sm:justify-between">
          {mode === "edit" ? (
            <Button
              variant="ghost"
              onClick={() => void del()}
              disabled={deleting || saving}
              className="text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={saving || !titleOk || body === undefined}
            >
              <Save className="h-3 w-3" />
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Read-only viewer for obsidian-authored notes that live elsewhere
 * in the vault. We don't write to these from the dashboard — Matt
 * (or another tool) authored them in Obsidian, and silently
 * round-tripping them through our editor would risk frontmatter
 * shape drift. Instead we render the markdown and offer a deep
 * link to open the file in Obsidian for editing.
 */
function ObsidianNoteDialog({
  note,
  onClose,
}: {
  note: NoteSummary;
  onClose: () => void;
}): React.JSX.Element {
  const [body, setBody] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invokeMcpTool<{ body: string }>("note_get", {
          relativePath: note.relativePath,
        });
        if (!cancelled) setBody(result.body);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setBody(note.preview);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [note.relativePath, note.preview]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{note.title}</span>
            <Badge
              variant="outline"
              className="text-[10px] uppercase tracking-wider"
            >
              obsidian · read-only
            </Badge>
          </DialogTitle>
          <DialogDescription>
            <code className="font-mono text-xs">{note.relativePath}</code>
            {" — "}edit in Obsidian to change the contents.
          </DialogDescription>
        </DialogHeader>

        {loading || body === undefined ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <ScrollArea className="h-[60vh] rounded-md border bg-muted/20 p-4">
            <article className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {body}
              </ReactMarkdown>
            </article>
          </ScrollArea>
        )}

        {loadError && (
          <p className="text-xs text-destructive">
            Couldn&apos;t load full body — falling back to preview. {loadError}
          </p>
        )}

        <DialogFooter className="sm:justify-between">
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
          </div>
          <div className="flex gap-2">
            {note.relativePath && (
              <Button
                variant="outline"
                onClick={() => {
                  const file = encodeURIComponent(note.relativePath ?? "");
                  window.open(`obsidian://open?file=${file}`, "_blank");
                }}
              >
                <ExternalLink className="h-3 w-3" />
                Open in Obsidian
              </Button>
            )}
            <Button onClick={onClose}>Close</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
