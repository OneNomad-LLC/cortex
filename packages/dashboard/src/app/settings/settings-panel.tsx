"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Save } from "lucide-react";

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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

interface Workspace {
  slug: string;
  path: string;
  active: boolean;
}

export function SettingsPanel(): React.JSX.Element {
  return (
    <Tabs defaultValue="identity">
      <TabsList>
        <TabsTrigger value="identity">Identity</TabsTrigger>
        <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
        <TabsTrigger value="projects">Projects</TabsTrigger>
        <TabsTrigger value="people">People</TabsTrigger>
        <TabsTrigger value="raw">Raw config</TabsTrigger>
      </TabsList>
      <TabsContent value="identity" className="mt-4">
        <IdentityTab />
      </TabsContent>
      <TabsContent value="workspaces" className="mt-4">
        <WorkspacesTab />
      </TabsContent>
      <TabsContent value="projects" className="mt-4">
        <WorkspaceFileEditor name="projects" />
      </TabsContent>
      <TabsContent value="people" className="mt-4">
        <WorkspaceFileEditor name="people" />
      </TabsContent>
      <TabsContent value="raw" className="mt-4">
        <RawConfigTab />
      </TabsContent>
    </Tabs>
  );
}

interface IdentityFields {
  slug?: string;
  name?: string;
  email?: string;
  role?: string;
  team?: string;
  timezone?: string;
  workHours?: string;
  aliases?: string[];
}

interface IdentityResponse {
  configured: boolean;
  identity: IdentityFields;
  missing: string[];
}

interface JobProfile {
  rawDescription?: string;
  role?: string;
  employer?: string;
  team?: string;
  responsibilities?: string[];
  deliverables?: string[];
  dailyTasks?: string[];
  weeklyTasks?: string[];
  stakeholders?: string[];
  successMetrics?: string[];
  playbook?: string;
  constraints?: string[];
  updatedAt?: string;
}

interface JobProfileResponse {
  configured: boolean;
  profile?: JobProfile;
  missing: string[];
  path: string;
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

function IdentityTab(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <UserIdentityCard />
      <JobProfileCard />
    </div>
  );
}

function UserIdentityCard(): React.JSX.Element {
  const [fields, setFields] = useState<IdentityFields | undefined>();
  const [initial, setInitial] = useState<IdentityFields | undefined>();
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await invokeMcpTool<IdentityResponse>(
        "get_user_identity",
        {},
      );
      setFields(result.identity);
      setInitial(result.identity);
      setMissing(result.missing);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function setField<K extends keyof IdentityFields>(
    key: K,
    value: IdentityFields[K],
  ): void {
    setFields((prev) => ({ ...(prev ?? {}), [key]: value }));
  }

  function setAliasesCsv(csv: string): void {
    const list = csv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    setField("aliases", list.length > 0 ? list : undefined);
  }

  async function save(): Promise<void> {
    if (!fields) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      const keys: Array<keyof IdentityFields> = [
        "slug",
        "name",
        "email",
        "role",
        "team",
        "timezone",
        "workHours",
        "aliases",
      ];
      for (const k of keys) {
        const v = fields[k];
        const i = initial?.[k];
        if (Array.isArray(v) || Array.isArray(i)) {
          if (JSON.stringify(v ?? []) !== JSON.stringify(i ?? [])) {
            patch[k] = v ?? [];
          }
        } else if ((v ?? "") !== (i ?? "")) {
          patch[k] = v ?? "";
        }
      }
      if (Object.keys(patch).length === 0) {
        toast.info("No changes to save.");
        return;
      }
      await invokeMcpTool("update_user_identity", patch);
      toast.success("Identity saved.");
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
          <CardTitle className="text-base">User identity</CardTitle>
          <CardDescription className="text-destructive">
            {error}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The session may not be bound to a workspace yet. Pick one in the
          Workspaces tab and reload.
        </CardContent>
      </Card>
    );
  }

  if (!fields || !initial) {
    return <Skeleton className="h-72 w-full" />;
  }

  const dirty =
    JSON.stringify(fields ?? {}) !== JSON.stringify(initial ?? {});
  const aliasesCsv = (fields.aliases ?? []).join(", ");

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">User identity</CardTitle>
            <CardDescription>
              How Cortex resolves &quot;me&quot; across meetings, emails, and
              code. Drives @-mention extraction and ranking against your work
              hours.
            </CardDescription>
          </div>
          <Button
            onClick={() => void save()}
            disabled={saving || !dirty}
            size="sm"
          >
            <Save className="h-3 w-3" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
        {missing.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {missing.map((m) => (
              <Badge
                key={m}
                variant="outline"
                className="text-[10px] uppercase"
              >
                missing: {m}
              </Badge>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <FieldRow
          id="ident-name"
          label="Name"
          value={fields.name ?? ""}
          onChange={(v) => setField("name", v || undefined)}
          placeholder="Your name"
        />
        <FieldRow
          id="ident-email"
          label="Email"
          value={fields.email ?? ""}
          onChange={(v) => setField("email", v || undefined)}
          placeholder="you@example.com"
          type="email"
        />
        <FieldRow
          id="ident-role"
          label="Role"
          value={fields.role ?? ""}
          onChange={(v) => setField("role", v || undefined)}
          placeholder="Engagement Technical Lead"
        />
        <FieldRow
          id="ident-team"
          label="Team"
          value={fields.team ?? ""}
          onChange={(v) => setField("team", v || undefined)}
          placeholder="Delivery"
        />
        <FieldRow
          id="ident-tz"
          label="Timezone"
          value={fields.timezone ?? ""}
          onChange={(v) => setField("timezone", v || undefined)}
          placeholder="America/New_York"
        />
        <FieldRow
          id="ident-hours"
          label="Work hours"
          value={fields.workHours ?? ""}
          onChange={(v) => setField("workHours", v || undefined)}
          placeholder="09:00-17:00"
        />
        <FieldRow
          id="ident-slug"
          label="Slug"
          value={fields.slug ?? ""}
          onChange={(v) => setField("slug", v || undefined)}
          placeholder="matt"
          help="kebab-case, used everywhere as the canonical id"
          className="sm:col-span-1"
        />
        <FieldRow
          id="ident-aliases"
          label="Aliases (csv)"
          value={aliasesCsv}
          onChange={setAliasesCsv}
          placeholder="Matt, M.S., mstvartak"
          help="Comma-separated alternate names that appear in emails / meetings"
          className="sm:col-span-1"
        />
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
  type,
  help,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  help?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
      />
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function JobProfileCard(): React.JSX.Element {
  const [response, setResponse] = useState<JobProfileResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [savedAt, setSavedAt] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await invokeMcpTool<JobProfileResponse>(
        "get_job_profile",
        {},
      );
      setResponse(result);
      setDraft(result.profile?.rawDescription ?? "");
      setError(undefined);
      setUnavailable(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 404 = tool not registered (private module not wired). Hide
      // gracefully so a stock cortex install doesn't see a broken
      // section.
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

  async function save(): Promise<void> {
    if (!draft.trim()) {
      toast.error("Paste a job description first.");
      return;
    }
    setSaving(true);
    try {
      await invokeMcpTool("set_job_profile", { rawDescription: draft });
      toast.success(
        "Job profile saved. Claude will distill it into responsibilities + a playbook on next session start.",
      );
      setSavedAt(Date.now());
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (unavailable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Job profile</CardTitle>
          <CardDescription>
            The career-automation module is not installed. Skip — cortex works
            without it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardTitle className="text-base">Job profile</CardTitle>
          <CardDescription className="text-destructive">
            {error}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!response) {
    return <Skeleton className="h-72 w-full" />;
  }

  const profile = response.profile;
  const updatedAt = profile?.updatedAt
    ? new Date(profile.updatedAt).toLocaleString()
    : undefined;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Job profile</CardTitle>
            <CardDescription>
              {response.configured
                ? "Distilled by Claude on each save. Drives tone + framing on work-related asks."
                : "Paste your job description below. Claude will distill it into responsibilities + a playbook on next session start."}
            </CardDescription>
          </div>
          <Button
            onClick={() => void save()}
            disabled={
              saving ||
              !draft.trim() ||
              draft.trim() === (profile?.rawDescription ?? "").trim()
            }
            size="sm"
          >
            <Save className="h-3 w-3" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
        {response.path && (
          <p className="mt-2 font-mono text-xs text-muted-foreground break-all">
            {response.path}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="jp-raw">Job description</Label>
          <Textarea
            id="jp-raw"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste your role description, responsibilities, deliverables, stakeholders..."
            className="min-h-[200px] text-sm"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Saved verbatim. The structured fields below get filled by Claude
            during your next session — paste and let it distill, don&apos;t
            try to fill them by hand here.
          </p>
        </div>

        {profile && response.configured && (
          <div className="space-y-3 border-t pt-4">
            {updatedAt && (
              <p className="text-xs text-muted-foreground">
                Last updated: {updatedAt}
                {savedAt && Date.now() - savedAt < 5_000 && (
                  <Badge variant="secondary" className="ml-2 text-[10px]">
                    just saved
                  </Badge>
                )}
              </p>
            )}
            <ProfileFieldList label="Role" value={profile.role} />
            <ProfileFieldList label="Employer" value={profile.employer} />
            <ProfileFieldList label="Team" value={profile.team} />
            <ProfileFieldList
              label="Responsibilities"
              value={profile.responsibilities}
            />
            <ProfileFieldList
              label="Deliverables"
              value={profile.deliverables}
            />
            <ProfileFieldList
              label="Daily tasks"
              value={profile.dailyTasks}
            />
            <ProfileFieldList
              label="Weekly tasks"
              value={profile.weeklyTasks}
            />
            <ProfileFieldList
              label="Stakeholders"
              value={profile.stakeholders}
            />
            <ProfileFieldList
              label="Success metrics"
              value={profile.successMetrics}
            />
            <ProfileFieldList
              label="Constraints"
              value={profile.constraints}
            />
            {profile.playbook && (
              <div className="space-y-1.5">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Playbook
                </Label>
                <pre className="whitespace-pre-wrap rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed">
                  {profile.playbook}
                </pre>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileFieldList({
  label,
  value,
}: {
  label: string;
  value: string | string[] | undefined;
}): React.JSX.Element | null {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return null;
  }
  return (
    <div className="space-y-1">
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {Array.isArray(value) ? (
        <ul className="ml-4 list-disc space-y-0.5 text-sm">
          {value.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm">{value}</p>
      )}
    </div>
  );
}

function WorkspacesTab(): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<Workspace[] | undefined>();
  const [newSlug, setNewSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/cortex/workspaces", { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const body = (await r.json()) as { workspaces: Workspace[] };
      setWorkspaces(body.workspaces);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function switchTo(slug: string): Promise<void> {
    setBusy(true);
    try {
      const r = await fetch("/api/cortex/workspaces/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      }
      toast.success(`Switched to ${slug} — restart Cortex to pick up the new config`);
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<void> {
    if (!newSlug.trim()) return;
    setBusy(true);
    try {
      const r = await fetch("/api/cortex/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: newSlug.trim() }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      }
      toast.success(`Created workspace '${newSlug.trim()}'`);
      setNewSlug("");
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(slug: string): Promise<void> {
    if (
      !window.confirm(
        `Delete workspace '${slug}'? Its config/.env/engram data under that folder will be removed.`,
      )
    )
      return;
    setBusy(true);
    try {
      const r = await fetch(
        `/api/cortex/workspaces/${encodeURIComponent(slug)}?confirm=true`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      }
      toast.success(`Deleted ${slug}`);
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardDescription className="text-destructive">
              {error}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create a workspace</CardTitle>
          <CardDescription>
            A workspace bundles its own config and .env, letting you keep
            personal + work contexts separate.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="new-ws">Slug</Label>
            <Input
              id="new-ws"
              placeholder="e.g. personal, work, side-project"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              disabled={busy}
            />
          </div>
          <Button onClick={() => void create()} disabled={busy || !newSlug.trim()}>
            Create
          </Button>
        </CardContent>
      </Card>

      {!workspaces ? (
        <div className="grid gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (
        <div className="grid gap-2">
          {workspaces.map((w) => (
            <Card key={w.slug}>
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{w.slug}</span>
                    {w.active && (
                      <Badge variant="secondary" className="text-[10px] uppercase">
                        active
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground font-mono break-all">
                    {w.path}
                  </p>
                </div>
                {!w.active && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void switchTo(w.slug)}
                    disabled={busy}
                  >
                    Switch
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void remove(w.slug)}
                  disabled={busy}
                  className="text-destructive hover:bg-destructive/10"
                >
                  Delete
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceFileEditor({
  name,
}: {
  name: "projects" | "people";
}): React.JSX.Element {
  const [content, setContent] = useState<string | undefined>();
  const [initial, setInitial] = useState<string | undefined>();
  const [filePath, setFilePath] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/cortex/workspace-files/${name}`, {
          cache: "no-store",
        });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const body = (await r.json()) as { path: string; content: string };
        if (cancelled) return;
        setContent(body.content);
        setInitial(body.content);
        setFilePath(body.path);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name]);

  async function save(): Promise<void> {
    if (content === undefined) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/cortex/workspace-files/${name}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      }
      toast.success(`${name}.yaml saved`);
      setInitial(content);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = content !== undefined && initial !== undefined && content !== initial;

  if (error) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardDescription className="text-destructive">
            Couldn&apos;t load {name}.yaml: {error}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (content === undefined) {
    return <Skeleton className="h-72 w-full" />;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base font-mono">{name}.yaml</CardTitle>
            {filePath && (
              <CardDescription className="font-mono text-xs break-all">
                {filePath}
              </CardDescription>
            )}
          </div>
          <Button
            onClick={() => void save()}
            disabled={saving || !dirty}
            size="sm"
          >
            <Save className="h-3 w-3" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-[400px] font-mono text-xs"
          spellCheck={false}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          YAML is validated on save. An invalid document won&apos;t overwrite
          the existing file — the error shows up as a toast instead.
        </p>
      </CardContent>
    </Card>
  );
}

function RawConfigTab(): React.JSX.Element {
  const [raw, setRaw] = useState<string | undefined>();
  const [filePath, setFilePath] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/cortex/config", { cache: "no-store" });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const body = (await r.json()) as { path: string; raw: string };
        if (cancelled) return;
        setRaw(body.raw);
        setFilePath(body.path);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardDescription className="text-destructive">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-mono">cortex.yaml</CardTitle>
        <CardDescription>
          Read-only view. Edit via the Adapters / Providers pages so changes
          round-trip through their wizard validation.
          {filePath && (
            <span className="ml-1 font-mono">({filePath})</span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[500px] rounded-md border bg-muted">
          <pre className="p-4 font-mono text-xs leading-relaxed">
            {raw ?? "Loading…"}
          </pre>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
