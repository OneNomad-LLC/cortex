"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Save, Sparkles, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { NoteEditor } from "./note-editor";
import { ProjectCombobox } from "./project-combobox";
import {
  invokeNoteTool,
  type MetadataSuggestion,
  type NoteRead,
} from "./lib/mcp";

interface NoteEditFormProps {
  mode: "create" | "edit";
  /** Pre-loaded note for edit mode. */
  initial?: NoteRead;
}

const SUGGEST_DEBOUNCE_MS = 1500;

export function NoteEditForm({
  mode,
  initial,
}: NoteEditFormProps): React.JSX.Element {
  const router = useRouter();

  const [title, setTitle] = useState(initial?.title ?? "");
  const [project, setProject] = useState(initial?.project ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [body, setBody] = useState(initial?.body ?? "");
  const [titleTouched, setTitleTouched] = useState(
    mode === "edit" && !!initial?.title,
  );

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  const titleOk = title.trim().length > 0 || body.trim().length >= 20;

  const lastAutoTitleBody = useRef<string>("");
  // Mutex via ref so the closure baked into the debounce setTimeout
  // sees the current value, not a stale one. setState alone isn't
  // enough because runSuggest's `suggesting` is captured at render.
  const inFlightRef = useRef<boolean>(false);

  // Auto-suggest a title (and merge tags) while the user types,
  // but only when they haven't typed a title themselves. Once they
  // type something, we stop overwriting. Debounced so we don't
  // hammer the LLM on every keystroke.
  useEffect(() => {
    if (titleTouched) return;
    if (body.trim().length < 40) return;
    if (body === lastAutoTitleBody.current) return;
    const handle = window.setTimeout(() => {
      void runSuggest({ silent: true, autoFillTitle: true });
      lastAutoTitleBody.current = body;
    }, SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, titleTouched]);

  const runSuggest = useCallback(
    async (opts: { silent?: boolean; autoFillTitle?: boolean } = {}) => {
      if (inFlightRef.current) return;
      if (body.trim().length < 20) {
        if (!opts.silent) toast.message("Add a few sentences first");
        return;
      }
      inFlightRef.current = true;
      setSuggesting(true);
      try {
        const result = await invokeNoteTool<MetadataSuggestion>(
          "note_suggest_metadata",
          {
            body,
            ...(title.trim() ? { currentTitle: title.trim() } : {}),
            currentTags: tags,
            ...(project.trim() ? { currentProject: project.trim() } : {}),
          },
        );
        const shouldFillTitle =
          opts.autoFillTitle ?? (!title.trim() || !titleTouched);
        if (shouldFillTitle && result.title) {
          setTitle(result.title);
        }
        setTags(result.tags);
        if (!project.trim() && result.project) setProject(result.project);
        if (!opts.silent) toast.success("Suggested title and tags");
      } catch (e) {
        if (!opts.silent) {
          toast.error(e instanceof Error ? e.message : String(e));
        }
      } finally {
        inFlightRef.current = false;
        setSuggesting(false);
      }
    },
    [body, title, tags, project, titleTouched],
  );

  async function handleSave(): Promise<void> {
    if (!titleOk || saving) return;
    setSaving(true);
    try {
      let finalTitle = title.trim();
      let finalTags = tags;
      let finalProject = project.trim();

      // Auto-fill missing metadata via the LLM on save. The user
      // asked for "auto all the time" — we fill in what's missing
      // (title, project) and merge in additional tag suggestions
      // without overwriting fields they actually filled in.
      if (body.trim().length >= 20) {
        try {
          const sug = await invokeNoteTool<MetadataSuggestion>(
            "note_suggest_metadata",
            {
              body,
              ...(finalTitle ? { currentTitle: finalTitle } : {}),
              currentTags: finalTags,
              ...(finalProject ? { currentProject: finalProject } : {}),
            },
          );
          if (!finalTitle && sug.title) finalTitle = sug.title;
          finalTags = sug.tags;
          if (!finalProject && sug.project) finalProject = sug.project;
        } catch {
          // Suggestion is best-effort; fall through with whatever
          // the user actually typed.
        }
      }
      if (!finalTitle) finalTitle = "Untitled note";

      if (mode === "create") {
        await invokeNoteTool("note_create", {
          title: finalTitle,
          body,
          ...(finalProject ? { project: finalProject } : {}),
          ...(finalTags.length > 0 ? { tags: finalTags } : {}),
        });
        toast.success(`Created: ${finalTitle}`);
      } else if (initial) {
        await invokeNoteTool("note_update", {
          slug: initial.id,
          title: finalTitle,
          body,
          project: finalProject || undefined,
          tags: finalTags.length > 0 ? finalTags : undefined,
        });
        toast.success(`Saved: ${finalTitle}`);
      }
      router.push("/notes");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!initial || deleting) return;
    if (!window.confirm(`Delete "${initial.title}"? This cannot be undone.`))
      return;
    setDeleting(true);
    try {
      await invokeNoteTool("note_delete", { slug: initial.id });
      toast.success(`Deleted ${initial.title}`);
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
          variant="ghost"
          size="sm"
          onClick={() => router.push("/notes")}
          className="text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to notes
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {mode === "edit" && initial ? (
            <code className="font-mono">{initial.relativePath}</code>
          ) : (
            <span>New note</span>
          )}
        </div>
      </header>

      <div className="grid flex-1 gap-6 py-6 lg:grid-cols-[1fr,260px]">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleTouched(true);
              }}
              placeholder="Title — leave blank and AI will write one"
              className="h-12 border-none bg-transparent px-0 text-2xl font-bold tracking-tight shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              autoFocus={mode === "create"}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void runSuggest({ autoFillTitle: true })}
              disabled={suggesting || body.trim().length < 20}
              title="Generate title and tags from the body"
              className="shrink-0 text-muted-foreground"
            >
              <Sparkles
                className={cn("h-4 w-4", suggesting && "animate-pulse")}
              />
              {suggesting ? "Thinking…" : "Suggest"}
            </Button>
          </div>

          <NoteEditor initialMarkdown={initial?.body ?? ""} onChange={setBody} />
        </div>

        <aside className="space-y-5">
          <Field label="Project">
            <ProjectCombobox value={project} onChange={setProject} />
          </Field>

          <Field label="Tags">
            <TagInput value={tags} onChange={setTags} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              AI fills these on save. Add your own — duplicates dedupe.
            </p>
          </Field>

          {mode === "edit" && initial && (
            <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Updated</span>{" "}
                {new Date(initial.updated).toLocaleString()}
              </p>
            </div>
          )}
        </aside>
      </div>

      <footer className="sticky bottom-0 -mx-6 mt-auto flex items-center justify-between gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        {mode === "edit" ? (
          <Button
            variant="ghost"
            onClick={() => void handleDelete()}
            disabled={deleting || saving}
            className="text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => router.push("/notes")}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !titleOk}
          >
            <Save className="h-4 w-4" />
            {saving
              ? "Saving…"
              : mode === "create"
                ? "Create note"
                : "Save changes"}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function TagInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");

  const normalized = useMemo(
    () =>
      draft
        .toLowerCase()
        .replace(/^#/, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, ""),
    [draft],
  );

  function commit(): void {
    if (!normalized) return;
    if (value.includes(normalized)) {
      setDraft("");
      return;
    }
    onChange([...value, normalized]);
    setDraft("");
  }

  function remove(tag: string): void {
    onChange(value.filter((t) => t !== tag));
  }

  return (
    <div
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5",
        "focus-within:border-ring focus-within:ring-1 focus-within:ring-ring",
      )}
    >
      {value.map((tag) => (
        <Badge
          key={tag}
          variant="secondary"
          className="gap-1 pr-1 text-[11px] font-normal"
        >
          #{tag}
          <button
            type="button"
            onClick={() => remove(tag)}
            className="rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={`Remove ${tag}`}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
            if (normalized) {
              e.preventDefault();
              commit();
            }
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (normalized) commit();
        }}
        placeholder={value.length === 0 ? "tag-name" : ""}
        className="flex-1 min-w-[60px] bg-transparent text-sm outline-none"
      />
    </div>
  );
}
