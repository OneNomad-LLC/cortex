"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Plus, Save, Trash2, AlertTriangle } from "lucide-react";

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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Project {
  slug: string;
  name: string;
  description?: string;
  active?: boolean;
  aliases?: string[];
  people?: string[];
  sources?: Record<string, unknown>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function ProjectsTab(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[] | undefined>();
  const [filePath, setFilePath] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/cortex/workspace-files/projects", {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const body = (await r.json()) as { path: string; content: string };
      const parsed = parseYaml(body.content);
      const list: Project[] = Array.isArray(parsed?.projects)
        ? (parsed.projects as Project[])
        : [];
      setProjects(list);
      setFilePath(body.path);
      setError(undefined);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function update(idx: number, patch: Partial<Project>): void {
    setProjects((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
    setDirty(true);
  }

  function addNew(): void {
    setProjects((prev) => [
      ...(prev ?? []),
      {
        slug: "new-project",
        name: "New project",
        description: "",
        active: true,
        aliases: [],
        people: [],
      },
    ]);
    setDirty(true);
  }

  function remove(idx: number): void {
    const proj = projects?.[idx];
    if (!proj) return;
    if (
      !window.confirm(
        `Delete project "${proj.name}" (${proj.slug})? This only removes the entry from projects.yaml — historical memories tagged with it stay searchable.`,
      )
    )
      return;
    setProjects((prev) => prev?.filter((_, i) => i !== idx));
    setDirty(true);
  }

  async function save(): Promise<void> {
    if (!projects) return;

    // Validation: every slug must match the regex, no duplicate slugs.
    const seenSlugs = new Set<string>();
    for (const p of projects) {
      if (!SLUG_RE.test(p.slug)) {
        toast.error(`Invalid slug "${p.slug}" — must be kebab-case (a-z, 0-9, -).`);
        return;
      }
      if (seenSlugs.has(p.slug)) {
        toast.error(`Duplicate slug "${p.slug}".`);
        return;
      }
      seenSlugs.add(p.slug);
      if (!p.name.trim()) {
        toast.error(`Project "${p.slug}" needs a name.`);
        return;
      }
    }

    setSaving(true);
    try {
      const yaml = stringifyYaml({ projects }, { indent: 2, lineWidth: 0 });
      const r = await fetch("/api/cortex/workspace-files/projects", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: yaml }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      }
      toast.success(`projects.yaml saved (${projects.length} projects)`);
      setDirty(false);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardTitle className="text-base">
            Couldn&apos;t load projects.yaml
          </CardTitle>
          <CardDescription className="text-destructive">
            {error}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!projects) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const activeCount = projects.filter((p) => p.active !== false).length;
  const inactiveCount = projects.length - activeCount;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Projects</CardTitle>
              <CardDescription>
                {projects.length} total · {activeCount} active
                {inactiveCount > 0 && ` · ${inactiveCount} archived`}
                {filePath && (
                  <span className="ml-2 font-mono text-xs">{filePath}</span>
                )}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={addNew}>
                <Plus className="h-3 w-3" />
                New project
              </Button>
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={saving || !dirty}
              >
                <Save className="h-3 w-3" />
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      <ul className="space-y-3">
        {projects.map((proj, idx) => (
          <li key={`${idx}-${proj.slug}`}>
            <ProjectCard
              project={proj}
              onChange={(patch) => update(idx, patch)}
              onRemove={() => remove(idx)}
            />
          </li>
        ))}
      </ul>

      {dirty && (
        <div className="sticky bottom-4 flex items-center justify-end gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm dark:border-amber-700/50 dark:bg-amber-950/30">
          <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-300" />
          <span className="flex-1 text-amber-900 dark:text-amber-200">
            Unsaved changes
          </span>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            <Save className="h-3 w-3" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  onChange,
  onRemove,
}: {
  project: Project;
  onChange: (patch: Partial<Project>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const slugOk = SLUG_RE.test(project.slug);
  return (
    <Card className={cn(project.active === false && "opacity-60")}>
      <CardContent className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldRow
            id={`name-${project.slug}`}
            label="Name"
            value={project.name}
            onChange={(v) => onChange({ name: v })}
            placeholder="Project display name"
          />
          <FieldRow
            id={`slug-${project.slug}`}
            label="Slug"
            value={project.slug}
            onChange={(v) => onChange({ slug: v })}
            placeholder="kebab-case-slug"
            invalid={!slugOk}
            help={
              !slugOk
                ? "Must match a-z, 0-9, hyphens; lowercase only"
                : "Used everywhere as the canonical id"
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`desc-${project.slug}`}>Description</Label>
          <Textarea
            id={`desc-${project.slug}`}
            value={project.description ?? ""}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="One-sentence description, surfaced in get_project_context"
            className="min-h-[60px] text-sm"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldRow
            id={`aliases-${project.slug}`}
            label="Aliases (csv)"
            value={(project.aliases ?? []).join(", ")}
            onChange={(v) =>
              onChange({
                aliases: v
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
            placeholder="ALPHA, alpha-team, the-alpha-project"
            help="Names found in meetings/docs that should resolve to this project"
          />
          <FieldRow
            id={`people-${project.slug}`}
            label="People (csv slugs)"
            value={(project.people ?? []).join(", ")}
            onChange={(v) =>
              onChange({
                people: v
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
            placeholder="matt, alex, brandon"
            help="People-tab slugs assigned to this project"
          />
        </div>

        <div className="flex items-center justify-between border-t pt-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id={`active-${project.slug}`}
                checked={project.active !== false}
                onCheckedChange={(checked) => onChange({ active: checked })}
              />
              <Label htmlFor={`active-${project.slug}`} className="cursor-pointer">
                Active
              </Label>
            </div>
            {project.sources && Object.keys(project.sources).length > 0 && (
              <Badge variant="outline" className="text-[10px]">
                {Object.keys(project.sources).length} source
                {Object.keys(project.sources).length === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            className="text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        </div>

        {project.sources && Object.keys(project.sources).length > 0 && (
          <details className="rounded-md border bg-muted/30 p-2 text-xs">
            <summary className="cursor-pointer font-medium">
              Source bindings (read-only here — edit via Adapters)
            </summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono">
              {JSON.stringify(project.sources, null, 2)}
            </pre>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function FieldRow({
  id,
  label,
  value,
  onChange,
  placeholder,
  help,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  help?: string;
  invalid?: boolean;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(invalid && "border-destructive focus-visible:ring-destructive")}
      />
      {help && (
        <p className={cn("text-xs", invalid ? "text-destructive" : "text-muted-foreground")}>
          {help}
        </p>
      )}
    </div>
  );
}
