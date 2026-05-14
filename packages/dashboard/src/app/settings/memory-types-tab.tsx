"use client";

import * as React from "react";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Origin = "built-in" | "config" | "auto";

interface MemoryTypeInfo {
  slug: string;
  label: string;
  origin: Origin;
  description?: string;
}

interface ListResponse {
  types: MemoryTypeInfo[];
}

/**
 * Settings → Memory types tab. Shows the merged registry (built-in +
 * customer-extensible custom types) and lets operators add, promote
 * auto-registered types to config, or remove customs.
 *
 * Built-ins are read-only. The `auto` badge flags types that arrived
 * from an LLM classifier output — operators should triage these
 * regularly, otherwise the taxonomy grows organically with whatever
 * the classifier emits.
 */
export function MemoryTypesTab(): React.JSX.Element {
  const [types, setTypes] = React.useState<MemoryTypeInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [draftSlug, setDraftSlug] = React.useState("");
  const [draftLabel, setDraftLabel] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/cortex/types", { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const body = (await r.json()) as ListResponse;
      setTypes(body.types ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftSlug.trim()) return;
    setSubmitting(true);
    try {
      const r = await fetch("/api/cortex/types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: draftSlug.trim(),
          ...(draftLabel.trim() ? { label: draftLabel.trim() } : {}),
        }),
      });
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `${r.status} ${r.statusText}`);
      }
      const body = (await r.json()) as ListResponse;
      setTypes(body.types ?? []);
      setDraftSlug("");
      setDraftLabel("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (slug: string) => {
    if (
      !confirm(
        `Remove "${slug}"? Memories already tagged with this type stay tagged — only the registry entry goes away.`,
      )
    )
      return;
    try {
      const r = await fetch(`/api/cortex/types/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `${r.status} ${r.statusText}`);
      }
      const body = (await r.json()) as ListResponse;
      setTypes(body.types ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const promote = async (slug: string) => {
    // Re-register as config; the server promotes auto → config in place.
    try {
      const r = await fetch("/api/cortex/types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `${r.status} ${r.statusText}`);
      }
      const body = (await r.json()) as ListResponse;
      setTypes(body.types ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const builtIn = types.filter((t) => t.origin === "built-in");
  const config = types.filter((t) => t.origin === "config");
  const auto = types.filter((t) => t.origin === "auto");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a memory type</CardTitle>
          <CardDescription>
            Slugs are normalized aggressively (lowercase, snake_case,
            plural → singular). The dashboard uses the label for display;
            the slug is what adapters stamp on memories.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={add}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="flex-1">
              <Label htmlFor="mt-slug" className="text-xs">
                Slug
              </Label>
              <Input
                id="mt-slug"
                placeholder="e.g. root_cause_analysis"
                value={draftSlug}
                onChange={(e) => setDraftSlug(e.target.value)}
                className="mt-1 font-mono text-sm"
              />
            </div>
            <div className="flex-1">
              <Label htmlFor="mt-label" className="text-xs">
                Label (optional)
              </Label>
              <Input
                id="mt-label"
                placeholder="Root Cause Analysis"
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                className="mt-1"
              />
            </div>
            <Button
              type="submit"
              disabled={submitting || !draftSlug.trim()}
              className="gap-1"
            >
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </form>
          {error && (
            <p className="mt-3 text-xs text-destructive">{error}</p>
          )}
        </CardContent>
      </Card>

      {auto.length > 0 && (
        <Card className="border-orange/40 bg-orange/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-orange" />
              Auto-registered types
            </CardTitle>
            <CardDescription>
              These slugs arrived from an LLM classifier or adapter output
              and were registered automatically. Promote the ones you
              want to keep; delete the typos and near-duplicates.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TypeList types={auto} onRemove={remove} onPromote={promote} />
          </CardContent>
        </Card>
      )}

      {config.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Custom types</CardTitle>
            <CardDescription>
              Added through this page (or by hand-editing{" "}
              <code className="font-mono text-xs">taxonomy.customTypes</code>{" "}
              in <code className="font-mono text-xs">cortex.yaml</code>).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TypeList types={config} onRemove={remove} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Built-in types</CardTitle>
          <CardDescription>
            Shipped with Cortex. These cannot be removed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {builtIn.map((t) => (
                <Badge
                  key={t.slug}
                  variant="outline"
                  className="font-mono text-xs"
                >
                  {t.slug}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TypeList({
  types,
  onRemove,
  onPromote,
}: {
  types: MemoryTypeInfo[];
  onRemove: (slug: string) => void;
  onPromote?: (slug: string) => void;
}): React.JSX.Element {
  return (
    <ul className="divide-y divide-border-subtle">
      {types.map((t) => (
        <li
          key={t.slug}
          className="flex items-center justify-between gap-3 py-2"
        >
          <div className="min-w-0">
            <p className="font-mono text-sm text-text-primary">{t.slug}</p>
            {t.label !== t.slug && (
              <p className="text-xs text-text-secondary">{t.label}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onPromote && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPromote(t.slug)}
                className="h-7 text-xs"
              >
                Keep
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRemove(t.slug)}
              className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
