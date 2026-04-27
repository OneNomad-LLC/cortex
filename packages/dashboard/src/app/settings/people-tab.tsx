"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Plus, Save, Trash2, AlertTriangle, User } from "lucide-react";

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
import { cn } from "@/lib/utils";

interface Person {
  slug: string;
  name: string;
  email: string;
  projects?: string[];
  role?: string;
  aliases?: string[];
  self?: boolean;
  team?: string;
  timezone?: string;
  workHours?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function PeopleTab(): React.JSX.Element {
  const [people, setPeople] = useState<Person[] | undefined>();
  const [filePath, setFilePath] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/cortex/workspace-files/people", {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const body = (await r.json()) as { path: string; content: string };
      const parsed = parseYaml(body.content);
      const list: Person[] = Array.isArray(parsed?.people)
        ? (parsed.people as Person[])
        : [];
      setPeople(list);
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

  function update(idx: number, patch: Partial<Person>): void {
    setPeople((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      // Enforce single-self invariant: if this update sets self=true,
      // unset it on every other entry.
      if (patch.self === true) {
        for (let i = 0; i < next.length; i++) {
          if (i !== idx && next[i].self) {
            next[i] = { ...next[i], self: false };
          }
        }
      }
      return next;
    });
    setDirty(true);
  }

  function addNew(): void {
    setPeople((prev) => [
      ...(prev ?? []),
      {
        slug: "new-person",
        name: "New Person",
        email: "you@example.com",
        projects: [],
        aliases: [],
      },
    ]);
    setDirty(true);
  }

  function remove(idx: number): void {
    const person = people?.[idx];
    if (!person) return;
    if (person.self) {
      toast.error(
        "Can't delete the user identity (self: true) here. Use the Identity tab to update it.",
      );
      return;
    }
    if (
      !window.confirm(
        `Delete person "${person.name}" (${person.slug})? This only removes the entry from people.yaml — historical memories that mention them stay searchable.`,
      )
    )
      return;
    setPeople((prev) => prev?.filter((_, i) => i !== idx));
    setDirty(true);
  }

  async function save(): Promise<void> {
    if (!people) return;

    // Validation: slugs + emails must be valid + slugs unique.
    const seenSlugs = new Set<string>();
    let selfCount = 0;
    for (const p of people) {
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
        toast.error(`Person "${p.slug}" needs a name.`);
        return;
      }
      if (!EMAIL_RE.test(p.email)) {
        toast.error(`Invalid email for "${p.slug}": ${p.email}`);
        return;
      }
      if (p.self) selfCount++;
    }
    if (selfCount > 1) {
      toast.error("Multiple people are marked self — only one can be.");
      return;
    }

    setSaving(true);
    try {
      // Strip undefined/empty fields before serializing for cleaner YAML.
      const cleaned = people.map((p) => {
        const out: Record<string, unknown> = {
          slug: p.slug,
          name: p.name,
          email: p.email,
        };
        if (p.role) out.role = p.role;
        if (p.team) out.team = p.team;
        if (p.timezone) out.timezone = p.timezone;
        if (p.workHours) out.workHours = p.workHours;
        if (p.self) out.self = true;
        if (p.projects && p.projects.length > 0) out.projects = p.projects;
        if (p.aliases && p.aliases.length > 0) out.aliases = p.aliases;
        return out;
      });
      const yaml = stringifyYaml(
        { people: cleaned },
        { indent: 2, lineWidth: 0 },
      );
      const r = await fetch("/api/cortex/workspace-files/people", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: yaml }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      }
      toast.success(`people.yaml saved (${people.length} people)`);
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
            Couldn&apos;t load people.yaml
          </CardTitle>
          <CardDescription className="text-destructive">
            {error}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!people) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const selfPerson = people.find((p) => p.self);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">People</CardTitle>
              <CardDescription>
                {people.length} total
                {selfPerson && (
                  <>
                    {" · self = "}
                    <span className="font-mono">{selfPerson.slug}</span>
                  </>
                )}
                {filePath && (
                  <span className="ml-2 font-mono text-xs">{filePath}</span>
                )}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={addNew}>
                <Plus className="h-3 w-3" />
                New person
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
        {people.map((person, idx) => (
          <li key={`${idx}-${person.slug}`}>
            <PersonCard
              person={person}
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

function PersonCard({
  person,
  onChange,
  onRemove,
}: {
  person: Person;
  onChange: (patch: Partial<Person>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const slugOk = SLUG_RE.test(person.slug);
  const emailOk = EMAIL_RE.test(person.email);
  return (
    <Card className={cn(person.self && "border-primary/40")}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{person.name || "(unnamed)"}</span>
          {person.self && (
            <Badge variant="secondary" className="text-[10px] uppercase">
              self
            </Badge>
          )}
          {person.role && (
            <Badge variant="outline" className="text-[10px]">
              {person.role}
            </Badge>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldRow
            id={`name-${person.slug}`}
            label="Name"
            value={person.name}
            onChange={(v) => onChange({ name: v })}
            placeholder="Full name"
          />
          <FieldRow
            id={`slug-${person.slug}`}
            label="Slug"
            value={person.slug}
            onChange={(v) => onChange({ slug: v })}
            placeholder="kebab-case"
            invalid={!slugOk}
          />
          <FieldRow
            id={`email-${person.slug}`}
            label="Email"
            value={person.email}
            onChange={(v) => onChange({ email: v })}
            placeholder="them@company.com"
            invalid={!emailOk}
            type="email"
          />
          <FieldRow
            id={`role-${person.slug}`}
            label="Role"
            value={person.role ?? ""}
            onChange={(v) => onChange({ role: v || undefined })}
            placeholder="Engineering, Product, Design…"
          />
          <FieldRow
            id={`team-${person.slug}`}
            label="Team"
            value={person.team ?? ""}
            onChange={(v) => onChange({ team: v || undefined })}
            placeholder="Platform, Delivery…"
          />
          <FieldRow
            id={`tz-${person.slug}`}
            label="Timezone"
            value={person.timezone ?? ""}
            onChange={(v) => onChange({ timezone: v || undefined })}
            placeholder="America/New_York"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldRow
            id={`projects-${person.slug}`}
            label="Projects (csv slugs)"
            value={(person.projects ?? []).join(", ")}
            onChange={(v) =>
              onChange({
                projects: v
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
            placeholder="alpha, beta, gamma"
          />
          <FieldRow
            id={`aliases-${person.slug}`}
            label="Aliases (csv)"
            value={(person.aliases ?? []).join(", ")}
            onChange={(v) =>
              onChange({
                aliases: v
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
            placeholder="Brandon T., bjt@company.com"
          />
        </div>

        <FieldRow
          id={`hours-${person.slug}`}
          label="Work hours"
          value={person.workHours ?? ""}
          onChange={(v) => onChange({ workHours: v || undefined })}
          placeholder="9am-5pm EST"
          help="Free-form. Used by digest + urgency ranker to avoid late-day flags."
        />

        <div className="flex items-center justify-between border-t pt-3">
          <div className="flex items-center gap-2">
            <Switch
              id={`self-${person.slug}`}
              checked={person.self === true}
              onCheckedChange={(checked) => onChange({ self: checked })}
            />
            <Label
              htmlFor={`self-${person.slug}`}
              className="cursor-pointer text-sm"
            >
              This is me (self)
            </Label>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            className="text-destructive hover:bg-destructive/10"
            disabled={person.self}
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        </div>
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
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
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
        type={type}
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
