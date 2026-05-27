/**
 * Memories browser. Paginated list of every ingested chunk in the
 * session's workspace with structural filters (type, source, project,
 * since-date) and a per-row detail panel rendered as markdown.
 *
 * Dossier framing: pipeline-code-dossier (Slice A) emits memories
 * tagged `dossier` with `type=brief`. The list view paints a
 * differently-colored 'Dossier' badge on those rows; the detail panel
 * carries the same badge plus the full structured body so the user
 * can verify what the dossier pipeline produced.
 *
 * Filter semantics: the type filter is multi-select; engram's search
 * is single-type so the backend fans out and merges (see
 * `routes/dashboard-memories.ts`). The user-facing pagination is
 * applied post-merge, so changing the type filter rewinds to page 1.
 */

import * as React from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Filter, Plug, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { renderMarkdown } from "@/lib/markdown";
import { useToast } from "@/components/ui/toast";

/**
 * Mirrors the server's VALID_TYPES + VALID_SOURCES. Kept in sync
 * manually because the server uses the same enum across kb_search /
 * search_related / kb_recent — drift here would silently drop filter
 * options on the UI without a 400.
 */
const TYPE_OPTIONS = [
  { value: "brief", label: "Brief" },
  { value: "decision", label: "Decision" },
  { value: "reference", label: "Reference" },
  { value: "doc", label: "Doc" },
  { value: "code", label: "Code" },
  { value: "note", label: "Note" },
  { value: "meeting", label: "Meeting" },
  { value: "conversation", label: "Conversation" },
  { value: "event", label: "Event" },
  { value: "action_item", label: "Action item" },
  { value: "digest", label: "Digest" },
  { value: "commit", label: "Commit" },
  { value: "session_handoff", label: "Session handoff" },
] as const;

const SOURCE_OPTIONS = [
  { value: "github", label: "GitHub" },
  { value: "loom", label: "Loom" },
  { value: "confluence", label: "Confluence" },
  { value: "notion", label: "Notion" },
  { value: "jira", label: "Jira" },
  { value: "linear", label: "Linear" },
  { value: "bitbucket", label: "Bitbucket" },
  { value: "obsidian", label: "Obsidian" },
  { value: "slack", label: "Slack" },
  { value: "email", label: "Email" },
  { value: "manual", label: "Manual" },
  { value: "google_drive", label: "Google Drive" },
  { value: "google_meet", label: "Google Meet" },
  { value: "calendar", label: "Calendar" },
  { value: "teams", label: "Teams" },
] as const;

const PER_PAGE = 50;
const ANY_SOURCE = "_any";

interface MemoryListItem {
  id: string;
  title: string | null;
  type: string | null;
  source: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  project: string | null;
  date: string | null;
  createdAt: string | null;
  snippet: string;
  tags: string[];
  isDossier: boolean;
}

interface MemoriesResponse {
  memories: MemoryListItem[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  workspace: string;
}

interface MemoryDetailItem extends MemoryListItem {
  content: string;
  metadata: Record<string, unknown>;
}

interface MemoryDetailResponse {
  memory: MemoryDetailItem;
}

export function MemoriesPage(): React.ReactElement {
  const [types, setTypes] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [source, setSource] = React.useState<string>(ANY_SOURCE);
  const [project, setProject] = React.useState("");
  const [debouncedProject, setDebouncedProject] = React.useState("");
  const [since, setSince] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  // Debounce free-text fields so the table doesn't refetch per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedProject(project.trim()), 250);
    return () => clearTimeout(t);
  }, [project]);
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Whenever a structural filter changes, rewind to page 1. Source is
  // covered via `Select`'s onValueChange below; the rest via this effect.
  React.useEffect(() => {
    setPage(1);
  }, [types, debouncedProject, since, debouncedQuery]);

  const url = React.useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("perPage", String(PER_PAGE));
    for (const t of types) params.append("type", t);
    if (source !== ANY_SOURCE) params.set("source", source);
    if (debouncedProject) params.set("project", debouncedProject);
    if (since) params.set("since", since);
    if (debouncedQuery) params.set("query", debouncedQuery);
    return `/api/dashboard/memories?${params.toString()}`;
  }, [page, types, source, debouncedProject, since, debouncedQuery]);

  const memories = useQuery<MemoriesResponse>({
    queryKey: ["dashboard", "memories", url],
    queryFn: () => api<MemoriesResponse>(url),
    refetchOnWindowFocus: false,
  });

  const toggleType = (next: string, checked: boolean) => {
    setTypes((prev) => {
      const out = new Set(prev);
      if (checked) out.add(next);
      else out.delete(next);
      return out;
    });
  };

  const clearFilters = () => {
    setTypes(new Set());
    setSource(ANY_SOURCE);
    setProject("");
    setSince("");
    setQuery("");
    setPage(1);
  };

  const total = memories.data?.total ?? 0;
  const rows = memories.data?.memories ?? [];

  return (
    <main className="flex-1 space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <BookOpen className="size-5" />
            Memories
          </h1>
          <p className="text-sm text-muted-foreground">
            Everything Cortex has ingested. Dossier entries are
            LLM-summarized briefs; other types are raw source content.
          </p>
        </div>
      </header>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
            <div className="relative w-full sm:max-w-sm">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Free-text search…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                aria-label="Search memories"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="memories-source" className="text-xs">
                Source
              </Label>
              <Select
                value={source}
                onValueChange={(next) => {
                  setSource(next);
                  setPage(1);
                }}
              >
                <SelectTrigger
                  id="memories-source"
                  className="w-[10rem]"
                  aria-label="Filter by source"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_SOURCE}>Any source</SelectItem>
                  {SOURCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="memories-project" className="text-xs">
                Project
              </Label>
              <Input
                id="memories-project"
                className="w-[10rem]"
                placeholder="project slug"
                value={project}
                onChange={(e) => setProject(e.currentTarget.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="memories-since" className="text-xs">
                Since
              </Label>
              <Input
                id="memories-since"
                type="date"
                className="w-[10rem]"
                value={since}
                onChange={(e) => setSince(e.currentTarget.value)}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="ml-auto"
            >
              <X className="size-4" />
              Reset
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-3 py-2">
            <Filter className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">
              Type
            </span>
            {TYPE_OPTIONS.map((o) => (
              <label
                key={o.value}
                className="flex items-center gap-1.5 text-xs"
              >
                <Checkbox
                  checked={types.has(o.value)}
                  onCheckedChange={(v) => toggleType(o.value, Boolean(v))}
                  aria-label={`Filter type ${o.label}`}
                />
                {o.label}
              </label>
            ))}
          </div>

          <div className="overflow-x-auto">
            {memories.isLoading ? (
              <div className="space-y-2 py-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : memories.isError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                Failed to load memories:{" "}
                {String(memories.error instanceof Error
                  ? memories.error.message
                  : memories.error)}
              </div>
            ) : rows.length === 0 ? (
              <MemoriesEmptyState hasFilters={
                types.size > 0 ||
                source !== ANY_SOURCE ||
                debouncedProject !== "" ||
                since !== "" ||
                debouncedQuery !== ""
              } />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">Title</th>
                    <th className="pb-2 pr-3 font-medium">Type</th>
                    <th className="pb-2 pr-3 font-medium">Source</th>
                    <th className="pb-2 pr-3 font-medium">Project</th>
                    <th className="pb-2 pr-3 font-medium">Ingested</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <MemoryRow
                      key={row.id}
                      row={row}
                      onOpen={() => setActiveId(row.id)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <PaginationFooter
            page={page}
            perPage={PER_PAGE}
            total={total}
            hasMore={memories.data?.hasMore ?? false}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </CardContent>
      </Card>

      <Dialog
        open={activeId !== null}
        onOpenChange={(open) => {
          if (!open) setActiveId(null);
        }}
      >
        {activeId ? <MemoryDetailDialog id={activeId} /> : null}
      </Dialog>
    </main>
  );
}

function MemoriesEmptyState(props: {
  hasFilters: boolean;
}): React.ReactElement {
  if (props.hasFilters) {
    return (
      <p className="px-1 py-6 text-sm text-muted-foreground">
        No memories match the current filters. Try widening or clearing them.
      </p>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3 px-1 py-8">
      <p className="text-sm text-muted-foreground">
        No memories yet — connect a source and run your first ingest.
      </p>
      <Link
        href="/adapters"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        <Plug className="size-3.5" />
        Go to Adapters
      </Link>
    </div>
  );
}

function MemoryRow(props: {
  row: MemoryListItem;
  onOpen: () => void;
}): React.ReactElement {
  const { row, onOpen } = props;
  return (
    <tr className="border-t">
      <td className="py-2 pr-3 align-top">
        <button
          type="button"
          onClick={onOpen}
          className="text-left font-medium underline-offset-4 hover:underline"
        >
          {row.title ?? row.snippet.slice(0, 80) ?? row.id}
        </button>
        {row.snippet && row.title ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">
            {row.snippet}
          </p>
        ) : null}
      </td>
      <td className="py-2 pr-3 align-top">
        <TypeBadge type={row.type} isDossier={row.isDossier} />
      </td>
      <td className="py-2 pr-3 align-top text-xs text-muted-foreground">
        {row.source ?? "—"}
      </td>
      <td className="py-2 pr-3 align-top text-xs text-muted-foreground">
        {row.project ?? "—"}
      </td>
      <td className="py-2 pr-3 align-top text-xs text-muted-foreground">
        {formatRelative(row.createdAt ?? row.date)}
      </td>
    </tr>
  );
}

function TypeBadge(props: {
  type: string | null;
  isDossier: boolean;
}): React.ReactElement {
  if (props.isDossier) {
    // Dossier badge uses the success palette so it visually pops out of
    // the otherwise-muted Type column — the whole point of the v0.6.0
    // memory browser is to make dossiers easy to spot at a glance.
    return <Badge variant="success">Dossier</Badge>;
  }
  if (!props.type) return <Badge variant="muted">—</Badge>;
  return <Badge variant="outline">{props.type}</Badge>;
}

function PaginationFooter(props: {
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
  onPrev: () => void;
  onNext: () => void;
}): React.ReactElement {
  const { page, perPage, total, hasMore, onPrev, onNext } = props;
  const start = total === 0 ? 0 : (page - 1) * perPage + 1;
  const end = Math.min(total, page * perPage);
  return (
    <div className="flex items-center justify-between pt-1">
      <p className="text-xs text-muted-foreground">
        {total === 0
          ? "0 memories"
          : `Showing ${start}–${end} of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onPrev}
          disabled={page <= 1}
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground">Page {page}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={!hasMore}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function MemoryDetailDialog(props: {
  id: string;
}): React.ReactElement {
  const { id } = props;
  const { toast } = useToast();

  const detail = useQuery<MemoryDetailResponse>({
    queryKey: ["dashboard", "memories", "detail", id],
    queryFn: () =>
      api<MemoryDetailResponse>(
        `/api/dashboard/memories/${encodeURIComponent(id)}`,
      ),
    refetchOnWindowFocus: false,
  });

  const memory = detail.data?.memory;
  const html = React.useMemo(
    () => (memory ? renderMarkdown(memory.content) : ""),
    [memory],
  );

  const copyContent = async () => {
    if (!memory) return;
    try {
      await navigator.clipboard.writeText(memory.content);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({
        title: "Copy failed",
        description: "Clipboard access was blocked.",
        variant: "destructive",
      });
    }
  };

  return (
    <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>
          {memory?.title ?? memory?.id ?? "Memory"}
        </DialogTitle>
        <DialogDescription>
          {memory?.type ? `${memory.type} · ` : ""}
          {memory?.source ?? "unknown source"}
        </DialogDescription>
      </DialogHeader>
      {detail.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : detail.isError || !memory ? (
        <p className="text-sm text-destructive">
          Couldn't load memory:{" "}
          {String(detail.error instanceof Error
            ? detail.error.message
            : detail.error ?? "not found")}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <TypeBadge type={memory.type} isDossier={memory.isDossier} />
            {memory.project ? (
              <Badge variant="outline">project: {memory.project}</Badge>
            ) : null}
            {memory.sourceUrl ? (
              <a
                href={memory.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline-offset-4 hover:underline"
              >
                Open source ↗
              </a>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void copyContent()}
              className="ml-auto h-7 px-2 text-xs"
            >
              Copy content
            </Button>
          </div>
          {memory.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {memory.tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="muted"
                  className="font-mono text-[10px]"
                >
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}
          <div
            className="prose prose-sm dark:prose-invert max-w-none [&_a]:text-primary [&_a]:underline-offset-4 hover:[&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-muted-foreground [&_li]:my-1 [&_ol]:ml-5 [&_ol]:list-decimal [&_p]:text-sm [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-xs [&_ul]:ml-5 [&_ul]:list-disc"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </DialogContent>
  );
}

const RELATIVE_THRESHOLDS: Array<[number, string]> = [
  [60, "s"],
  [60, "m"],
  [24, "h"],
  [7, "d"],
  [4.348, "w"],
  [12, "mo"],
  [Number.POSITIVE_INFINITY, "y"],
];

function formatRelative(input?: string | null): string {
  if (!input) return "—";
  const d = Date.parse(input);
  if (!Number.isFinite(d)) return "—";
  let diff = (Date.now() - d) / 1000;
  if (diff < 5) return "just now";
  for (const [scale, unit] of RELATIVE_THRESHOLDS) {
    if (diff < scale) return `${Math.floor(diff)}${unit} ago`;
    diff /= scale;
  }
  return new Date(d).toLocaleDateString();
}
