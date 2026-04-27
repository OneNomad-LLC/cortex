"use client";

import * as React from "react";
import { useCallback, useMemo, useState } from "react";
import {
  ExternalLink,
  Filter,
  Search as SearchIcon,
  X,
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { invokeMcpTool } from "@/lib/api";

export const dynamic = "force-dynamic";

interface SearchResult {
  id: string;
  title?: string;
  snippet: string;
  score?: number;
  type?: string;
  source?: string;
  project?: string | string[];
  source_url?: string;
  date?: string;
  people?: string[];
  due_date?: string;
  urgency?: string;
  mentions_me?: boolean;
}

interface SearchOutput {
  query: string;
  count: number;
  results: SearchResult[];
}

const TYPE_OPTIONS = [
  "meeting",
  "decision",
  "action_item",
  "doc",
  "code",
  "note",
  "brief",
  "digest",
  "conversation",
  "commit",
  "event",
  "reference",
  "session_handoff",
] as const;

const SOURCE_OPTIONS = [
  "loom",
  "google_meet",
  "confluence",
  "notion",
  "google_drive",
  "jira",
  "linear",
  "bitbucket",
  "github",
  "calendar",
  "slack",
  "teams",
  "email",
  "obsidian",
  "manual",
] as const;

const ANY_VALUE = "__any__";

export default function SearchPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Search</h1>
        <p className="text-sm text-muted-foreground">
          Semantic + keyword search across every memory ingested into the
          current workspace.
        </p>
      </header>
      <SearchPanel />
    </div>
  );
}

function SearchPanel(): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string>(ANY_VALUE);
  const [source, setSource] = useState<string>(ANY_VALUE);
  const [project, setProject] = useState("");
  const [since, setSince] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [output, setOutput] = useState<SearchOutput | undefined>();

  const filters = useMemo(
    () => ({ type, source, project: project.trim(), since: since.trim() }),
    [type, source, project, since],
  );

  const run = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(undefined);
    try {
      const input: Record<string, unknown> = { query: q, limit: 25 };
      if (filters.type !== ANY_VALUE) input.type = filters.type;
      if (filters.source !== ANY_VALUE) input.source = filters.source;
      if (filters.project) input.project = filters.project;
      if (filters.since) {
        // Accept "YYYY-MM-DD" inputs and normalize to ISO 8601 datetime.
        const d = new Date(filters.since);
        if (!Number.isNaN(d.getTime())) input.since = d.toISOString();
      }
      const result = await invokeMcpTool<SearchOutput>(
        "search_related",
        input,
      );
      setOutput(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOutput(undefined);
    } finally {
      setLoading(false);
    }
  }, [query, filters]);

  function clearFilters(): void {
    setType(ANY_VALUE);
    setSource(ANY_VALUE);
    setProject("");
    setSince("");
  }

  const activeFilterCount =
    (type !== ANY_VALUE ? 1 : 0) +
    (source !== ANY_VALUE ? 1 : 0) +
    (project ? 1 : 0) +
    (since ? 1 : 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
            className="space-y-3"
          >
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="What are you looking for?"
                  className="pl-9"
                  autoFocus
                />
              </div>
              <Button
                type="submit"
                disabled={loading || !query.trim()}
              >
                {loading ? "Searching…" : "Search"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowFilters((v) => !v)}
              >
                <Filter className="h-3 w-3" />
                Filters
                {activeFilterCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-1 h-4 px-1.5 text-[10px]"
                  >
                    {activeFilterCount}
                  </Badge>
                )}
              </Button>
            </div>
            {showFilters && (
              <div className="grid gap-3 border-t pt-3 sm:grid-cols-2 lg:grid-cols-4">
                <FilterSelect
                  id="filter-type"
                  label="Type"
                  value={type}
                  onChange={setType}
                  options={TYPE_OPTIONS}
                />
                <FilterSelect
                  id="filter-source"
                  label="Source"
                  value={source}
                  onChange={setSource}
                  options={SOURCE_OPTIONS}
                />
                <div className="space-y-1.5">
                  <Label htmlFor="filter-project">Project slug</Label>
                  <Input
                    id="filter-project"
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                    placeholder="e.g. alpha"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="filter-since">Since</Label>
                  <Input
                    id="filter-since"
                    type="date"
                    value={since}
                    onChange={(e) => setSince(e.target.value)}
                  />
                </div>
                {activeFilterCount > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearFilters}
                    className="sm:col-span-2 lg:col-span-4 justify-self-end"
                  >
                    <X className="h-3 w-3" />
                    Clear filters
                  </Button>
                )}
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              Search failed
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {loading && <ResultSkeletons />}

      {!loading && output && <ResultsList output={output} />}

      {!loading && !output && !error && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Try a query</CardTitle>
            <CardDescription>
              &quot;auth migration decisions&quot;, &quot;upcoming RFP responses&quot;,
              &quot;what did Brandon say about onboarding&quot; — semantic search,
              not keyword.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY_VALUE}>Any</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o.replace(/_/g, " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ResultSkeletons(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function ResultsList({ output }: { output: SearchOutput }): React.JSX.Element {
  if (output.count === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No matches</CardTitle>
          <CardDescription>
            Nothing in this workspace matches{" "}
            <span className="font-mono">&quot;{output.query}&quot;</span>. Try
            broader terms, drop a filter, or check that adapters are syncing
            under <code className="font-mono">/status</code>.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {output.count} result{output.count === 1 ? "" : "s"} for{" "}
        <span className="font-mono">&quot;{output.query}&quot;</span>
      </p>
      <ul className="space-y-2">
        {output.results.map((r) => (
          <li key={r.id}>
            <ResultCard result={r} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultCard({ result }: { result: SearchResult }): React.JSX.Element {
  const projectStr = Array.isArray(result.project)
    ? result.project.join(", ")
    : result.project;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          {result.title ? (
            <span className="text-sm font-medium">{result.title}</span>
          ) : (
            <span className="text-sm font-medium text-muted-foreground italic">
              (untitled)
            </span>
          )}
          {result.score !== undefined && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {result.score.toFixed(2)}
            </span>
          )}
          {result.mentions_me && (
            <Badge variant="secondary" className="text-[10px] uppercase">
              mentions you
            </Badge>
          )}
          {result.source_url && (
            <a
              href={result.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-muted-foreground hover:text-foreground"
              aria-label="Open source"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
        <p className="text-sm text-muted-foreground line-clamp-3">
          {result.snippet}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {result.type && (
            <Badge variant="outline" className="text-[10px]">
              {result.type.replace(/_/g, " ")}
            </Badge>
          )}
          {result.source && (
            <Badge variant="outline" className="text-[10px]">
              {result.source}
            </Badge>
          )}
          {projectStr && (
            <Badge variant="outline" className="text-[10px]">
              {projectStr}
            </Badge>
          )}
          {result.urgency && result.urgency !== "low" && (
            <Badge
              variant={
                result.urgency === "high" ? "destructive" : "secondary"
              }
              className="text-[10px] uppercase"
            >
              {result.urgency}
            </Badge>
          )}
          {result.date && <span>{formatDate(result.date)}</span>}
          {result.due_date && (
            <span className="text-foreground">
              due {formatDate(result.due_date)}
            </span>
          )}
          {result.people && result.people.length > 0 && (
            <span>{result.people.join(", ")}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
