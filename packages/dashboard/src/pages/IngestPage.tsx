/**
 * Dashboard Ingest page.
 *
 * Three tabs: URL / File / Raw content. Each tab posts to its matching
 * `/api/dashboard/ingest/*` endpoint. On success the page toasts and
 * (for async ingests) links to the Jobs page with the jobId prefilled.
 */

import * as React from "react";
import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/api";

interface IngestUrlResponse {
  ok: boolean;
  jobId: string;
  queued: boolean;
}

interface IngestFileResponse {
  ok: boolean;
  jobId?: string;
  ingested?: number;
  sourceId?: string;
}

interface IngestContentResponse {
  ok: boolean;
  ingested: number;
  sourceId: string;
  memories: Array<{ content_preview: string }>;
}

export default function IngestPage() {
  return (
    <section className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Ingest</h1>
        <p className="text-sm text-muted-foreground">
          One-off ingestion for content that doesn't have a scheduled adapter.
          For recurring sources (GitHub, Slack, Notion, etc.) use{" "}
          <Link
            href="/adapters"
            className="text-primary underline-offset-4 hover:underline"
          >
            Adapters
          </Link>{" "}
          instead. URL ingests queue asynchronously and return a jobId —
          track progress on the Jobs page.
        </p>
      </header>

      <Tabs defaultValue="url" className="flex flex-col gap-4">
        <TabsList>
          <TabsTrigger value="url">URL</TabsTrigger>
          <TabsTrigger value="file">File</TabsTrigger>
          <TabsTrigger value="content">Raw content</TabsTrigger>
        </TabsList>

        <TabsContent value="url">
          <UrlIngestForm />
        </TabsContent>
        <TabsContent value="file">
          <FileIngestForm />
        </TabsContent>
        <TabsContent value="content">
          <ContentIngestForm />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function FormCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function UrlIngestForm() {
  const { toast } = useToast();
  const [url, setUrl] = React.useState("");
  const [project, setProject] = React.useState("");
  const [crawlDepth, setCrawlDepth] = React.useState(0);
  const [maxPages, setMaxPages] = React.useState(50);
  const [tags, setTags] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [lastJobId, setLastJobId] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await apiFetch<IngestUrlResponse>("/api/dashboard/ingest/url", {
        method: "POST",
        body: JSON.stringify({
          url,
          ...(project ? { project } : {}),
          crawlDepth,
          maxPages,
          tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        }),
      });
      setLastJobId(result.jobId);
      toast({
        title: "Job queued",
        description: `URL ingest queued as ${result.jobId.slice(0, 8)}…`,
      });
    } catch (err) {
      toast({
        title: "Ingest failed",
        description: (err as { error?: string; message?: string }).message ??
          (err as { error?: string }).error ??
          String(err),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormCard
      title="Ingest a URL"
      description="Single page or a same-host crawl. Async — returns a jobId you can track on the Jobs page."
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="URL" required>
            <Input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/docs"
            />
          </Field>
          <Field label="Project (optional)">
            <Input
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="default"
            />
          </Field>
          <Field label="Crawl depth (0 = single page)">
            <Input
              type="number"
              min={0}
              max={5}
              value={crawlDepth}
              onChange={(e) => setCrawlDepth(Number(e.target.value))}
            />
          </Field>
          <Field label="Max pages">
            <Input
              type="number"
              min={1}
              max={500}
              value={maxPages}
              onChange={(e) => setMaxPages(Number(e.target.value))}
            />
          </Field>
          <Field label="Tags (comma-separated)" className="sm:col-span-2">
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="docs, onboarding"
            />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={submitting || !url}>
            {submitting ? "Queueing…" : "Ingest URL"}
          </Button>
          {lastJobId && (
            <Link
              href={`/jobs`}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              View {lastJobId.slice(0, 8)}… on Jobs page →
            </Link>
          )}
        </div>
      </form>
    </FormCard>
  );
}

function FileIngestForm() {
  const { toast } = useToast();
  const [path, setPath] = React.useState("");
  const [project, setProject] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<IngestFileResponse | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await apiFetch<IngestFileResponse>("/api/dashboard/ingest/file", {
        method: "POST",
        body: JSON.stringify({
          path,
          ...(project ? { project } : {}),
          tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        }),
      });
      setLastResult(result);
      toast({
        title: result.jobId ? "Job queued" : "Ingested",
        description: result.jobId
          ? `File ingest queued as ${result.jobId.slice(0, 8)}…`
          : `Ingested ${result.ingested ?? 0} chunks`,
      });
    } catch (err) {
      toast({
        title: "Ingest failed",
        description: (err as { error?: string; message?: string }).message ??
          (err as { error?: string }).error ??
          String(err),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormCard
      title="Ingest a file from disk"
      description="The file must be readable by the Cortex process. Bind-mount the path in docker-compose if you're running containerized."
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <Field label="Absolute path" required>
          <Input
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/file.md"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Project (optional)">
            <Input
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="default"
            />
          </Field>
          <Field label="Tags (comma-separated)">
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="reference, runbook"
            />
          </Field>
        </div>
        <Button type="submit" disabled={submitting || !path}>
          {submitting ? "Ingesting…" : "Ingest file"}
        </Button>
        {lastResult && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {lastResult.jobId
              ? `Job queued: ${lastResult.jobId}`
              : `Ingested ${lastResult.ingested ?? 0} chunk${(lastResult.ingested ?? 0) === 1 ? "" : "s"}`}
            {lastResult.sourceId ? (
              <span className="ml-2 font-mono">{lastResult.sourceId}</span>
            ) : null}
          </div>
        )}
      </form>
    </FormCard>
  );
}

function ContentIngestForm() {
  const { toast } = useToast();
  const [title, setTitle] = React.useState("");
  const [type, setType] = React.useState("note");
  const [project, setProject] = React.useState("");
  const [sourceId, setSourceId] = React.useState("");
  const [sourceUrl, setSourceUrl] = React.useState("");
  const [content, setContent] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<IngestContentResponse | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await apiFetch<IngestContentResponse>(
        "/api/dashboard/ingest/content",
        {
          method: "POST",
          body: JSON.stringify({
            content,
            ...(title ? { title } : {}),
            type,
            ...(project ? { project } : {}),
            sourceId: sourceId || `dashboard://content/${Date.now()}`,
            ...(sourceUrl ? { sourceUrl } : {}),
            tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
          }),
        },
      );
      setLastResult(result);
      toast({
        title: "Ingested",
        description: `Stored ${result.ingested} chunk${result.ingested === 1 ? "" : "s"}`,
      });
    } catch (err) {
      toast({
        title: "Ingest failed",
        description: (err as { error?: string; message?: string }).message ??
          (err as { error?: string }).error ??
          String(err),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormCard
      title="Ingest raw content"
      description="Paste content directly. Runs synchronously — the response includes the count of chunks stored."
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Meeting notes 2026-05-20"
            />
          </Field>
          <Field label="Type">
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="note">note</option>
              <option value="doc">doc</option>
              <option value="meeting">meeting</option>
              <option value="conversation">conversation</option>
              <option value="decision">decision</option>
              <option value="brief">brief</option>
              <option value="digest">digest</option>
            </select>
          </Field>
          <Field label="Project">
            <Input
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="default"
            />
          </Field>
          <Field label="Source id">
            <Input
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              placeholder="dashboard://content/…"
            />
          </Field>
          <Field label="Source URL" className="sm:col-span-2">
            <Input
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://…"
            />
          </Field>
          <Field label="Tags (comma-separated)" className="sm:col-span-2">
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="reference, meeting"
            />
          </Field>
        </div>
        <Field label="Content">
          <textarea
            required
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder="Paste content here…"
            className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
          />
        </Field>
        <Button type="submit" disabled={submitting || !content}>
          {submitting ? "Ingesting…" : "Ingest content"}
        </Button>
        {lastResult && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Ingested {lastResult.ingested} chunk{lastResult.ingested === 1 ? "" : "s"}
            {lastResult.sourceId ? (
              <span className="ml-2 font-mono">{lastResult.sourceId}</span>
            ) : null}
          </div>
        )}
      </form>
    </FormCard>
  );
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 text-xs text-muted-foreground ${className ?? ""}`}>
      {label}
      {required && <span className="sr-only"> (required)</span>}
      {children}
    </label>
  );
}
