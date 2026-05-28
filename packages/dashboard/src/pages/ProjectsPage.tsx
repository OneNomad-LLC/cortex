/**
 * Projects page — list and create org projects.
 *
 * Reads from: GET  /api/dashboard/projects → { projects: ProjectRow[] }
 * Creates via: POST /api/dashboard/projects  body { slug, name }
 *
 * Each project card shows its member count (from the members list, if
 * available) and a slug for use in project-scope chip selectors on the
 * Members page.
 */

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Loader2, Plus } from "lucide-react";

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
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/components/ui/toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  createdAt: string;
}

interface ProjectsResponse {
  projects: ProjectRow[];
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;

function CreateProjectDialog(props: {
  onCreated: () => void;
}): React.ReactElement {
  const { onCreated } = props;
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugTouched, setSlugTouched] = React.useState(false);

  // Auto-generate slug from name while the user hasn't manually edited it.
  React.useEffect(() => {
    if (!slugTouched) {
      setSlug(
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 63),
      );
    }
  }, [name, slugTouched]);

  const slugError =
    slug.length > 0 && !SLUG_RE.test(slug)
      ? "Slug must be lowercase alphanumeric with hyphens (e.g. my-project)"
      : null;

  const mutation = useMutation({
    mutationFn: async (data: { slug: string; name: string }) =>
      api("/api/dashboard/projects", {
        method: "POST",
        body: data,
      }),
    onSuccess: () => {
      toast({ title: `Created project "${name}"` });
      setName("");
      setSlug("");
      setSlugTouched(false);
      setOpen(false);
      onCreated();
    },
    onError: (err) => {
      const detail =
        err instanceof ApiError && err.status === 409
          ? "A project with that slug already exists."
          : err instanceof Error
            ? err.message
            : String(err);
      toast({ title: "Create failed", description: detail, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim() || slugError) return;
    mutation.mutate({ name: name.trim(), slug: slug.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-2 size-4" />
          New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Projects group members and scope query visibility.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              placeholder="e.g. Search API"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-slug">Slug</Label>
            <Input
              id="project-slug"
              placeholder="e.g. search-api"
              value={slug}
              onChange={(e) => {
                setSlug(e.currentTarget.value);
                setSlugTouched(true);
              }}
              aria-invalid={slugError !== null}
              required
            />
            {slugError ? (
              <p role="alert" className="text-xs text-destructive">
                {slugError}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || slugError !== null}
            >
              {mutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ProjectsPage(): React.ReactElement {
  const queryClient = useQueryClient();

  const projectsQuery = useQuery<ProjectsResponse, ApiError>({
    queryKey: ["dashboard", "projects"],
    queryFn: () => api<ProjectsResponse>("/api/dashboard/projects"),
    refetchOnWindowFocus: false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["dashboard", "projects"] });
  };

  const projects = projectsQuery.data?.projects ?? [];

  return (
    <main className="flex-1 space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <FolderOpen className="size-5" />
            Projects
          </h1>
          <p className="text-sm text-muted-foreground">
            Projects scope query visibility and member access.
          </p>
        </div>
        <CreateProjectDialog onCreated={invalidate} />
      </header>

      {projectsQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      ) : projectsQuery.isError ? (
        <p className="text-sm text-destructive">
          Failed to load projects:{" "}
          {projectsQuery.error instanceof ApiError &&
          projectsQuery.error.status === 400
            ? "przm-access not configured (PRZM_ACCESS_ADMIN_URL, PRZM_ACCESS_OPERATOR_KEY, PRZM_ACCESS_TENANT_ID required)"
            : projectsQuery.error.message}
        </p>
      ) : projects.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No projects yet. Create one to start scoping member access.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Card key={p.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{p.name}</CardTitle>
                <CardDescription>
                  <Badge variant="muted" className="font-mono text-xs">
                    {p.slug}
                  </Badge>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  Created {formatDate(p.createdAt)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "—";
  return new Date(d).toLocaleDateString();
}
