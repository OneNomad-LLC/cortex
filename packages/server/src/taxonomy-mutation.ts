import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  jobProfileFileSchema,
  normalizeAlias,
  peopleFileSchema,
  projectsFileSchema,
  type JobProfile,
  type Person,
  type Project,
} from "@onenomad/przm-cortex-core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ensureLocalCopy } from "./cli/config-mutation.js";

/**
 * Persistence helpers for the identity + taxonomy-gap MCP tools.
 *
 * Reads and writes go through `ensureLocalCopy` so edits land in the
 * `.local.yaml` overlay (the one the loader actually reads) rather
 * than the committed template.
 *
 * Concurrency: upsertPerson / upsertProject / markSelf are
 * read-modify-write against YAML files. Two concurrent tool calls on
 * the same workspace would race (both read the pre-patch state, each
 * writes its own, last-write-wins swallows the earlier update). The
 * per-workspace `runLocked` serializes all mutations in this module
 * keyed by the workspace root path. Reads are unlocked — YAML parses
 * are safe against the atomic writer on the other side.
 */

/**
 * Per-workspace promise chain. Each `runLocked` appends a task to the
 * chain for that workspace; concurrent tasks wait for the prior one
 * to settle before running. In-process only — cross-process (multiple
 * Cortex instances hitting the same workspace dir) would still race
 * and needs a file lock, which we don't have yet.
 */
const mutationLocks = new Map<string, Promise<unknown>>();

async function runLocked<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = mutationLocks.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  // Keep the chain alive only while the tail is still pending; once
  // done, clear it so we don't pin errored promises in the map.
  mutationLocks.set(key, next);
  next.finally(() => {
    if (mutationLocks.get(key) === next) mutationLocks.delete(key);
  }).catch(() => undefined);
  return next;
}

export interface TaxonomyPaths {
  /** Workspace root (active workspace path). Files live under config/. */
  repoRoot: string;
}

function peoplePath(paths: TaxonomyPaths): string {
  return path.join(paths.repoRoot, "config", "people.yaml");
}

function projectsPath(paths: TaxonomyPaths): string {
  return path.join(paths.repoRoot, "config", "projects.yaml");
}

/** Read the current people list (from local overlay if present). */
export async function readPeople(paths: TaxonomyPaths): Promise<Person[]> {
  const filePath = await ensureLocalCopy(peoplePath(paths));
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const parsed = peopleFileSchema.parse(parseYaml(raw) ?? {});
  return parsed.people;
}

export async function readProjects(paths: TaxonomyPaths): Promise<Project[]> {
  const filePath = await ensureLocalCopy(projectsPath(paths));
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const parsed = projectsFileSchema.parse(parseYaml(raw) ?? {});
  return parsed.projects;
}

/**
 * Write a merged people list. Existing entries with matching slug are
 * replaced by the new value (patch semantics); new slugs append.
 */
export async function writePeople(
  paths: TaxonomyPaths,
  next: Person[],
): Promise<string> {
  const filePath = await ensureLocalCopy(peoplePath(paths));
  const out = stringifyYaml({ people: next }, { indent: 2, lineWidth: 0 });
  await writeFile(filePath, out, "utf8");
  return filePath;
}

export async function writeProjects(
  paths: TaxonomyPaths,
  next: Project[],
): Promise<string> {
  const filePath = await ensureLocalCopy(projectsPath(paths));
  const out = stringifyYaml({ projects: next }, { indent: 2, lineWidth: 0 });
  await writeFile(filePath, out, "utf8");
  return filePath;
}

/**
 * Upsert a person by slug. Returns the merged entry and whether it
 * was newly created. Serialized per-workspace.
 */
export async function upsertPerson(
  paths: TaxonomyPaths,
  patch: Partial<Person> & { slug: string },
): Promise<{ person: Person; created: boolean }> {
  return runLocked(paths.repoRoot, async () => {
    const people = await readPeople(paths);
    const idx = people.findIndex((p) => p.slug === patch.slug);
    const base: Person =
      idx >= 0
        ? people[idx]!
        : {
            slug: patch.slug,
            name: patch.name ?? patch.slug,
            email: patch.email ?? `${patch.slug}@unknown`,
            projects: [],
            aliases: [],
          };
    const merged: Person = {
      ...base,
      ...patch,
      projects: patch.projects ?? base.projects,
      aliases: patch.aliases ?? base.aliases,
    };
    if (idx >= 0) {
      people[idx] = merged;
    } else {
      people.push(merged);
    }
    await writePeople(paths, people);
    return { person: merged, created: idx < 0 };
  });
}

/**
 * Upsert a project by slug. Same semantics as upsertPerson. Serialized
 * per-workspace.
 */
export async function upsertProject(
  paths: TaxonomyPaths,
  patch: Partial<Project> & { slug: string },
): Promise<{ project: Project; created: boolean }> {
  return runLocked(paths.repoRoot, async () => {
    const projects = await readProjects(paths);
    const idx = projects.findIndex((p) => p.slug === patch.slug);
    const base: Project =
      idx >= 0
        ? projects[idx]!
        : {
            slug: patch.slug,
            name: patch.name ?? patch.slug,
            active: patch.active ?? true,
            description: patch.description ?? "",
            aliases: [],
            people: [],
            sources: {},
          };
    const merged: Project = {
      ...base,
      ...patch,
      aliases: patch.aliases ?? base.aliases,
      people: patch.people ?? base.people,
      sources: patch.sources ?? base.sources,
    };
    if (idx >= 0) {
      projects[idx] = merged;
    } else {
      projects.push(merged);
    }
    await writeProjects(paths, projects);
    return { project: merged, created: idx < 0 };
  });
}

export interface AddProjectResult {
  project: Project;
  /** false when an existing project matched the slug or an alias —
   *  nothing was written in that case. */
  created: boolean;
  /** Which supplied value collided with an existing project. Only set
   *  when created=false. */
  matchedOn?: { kind: "slug" | "alias"; value: string };
}

/**
 * Create a project, deduping on slug AND aliases. Unlike upsertProject
 * (which patches an existing slug), this is strictly non-destructive:
 * if the slug or any supplied alias already resolves to a project — in
 * either direction (new slug == an existing alias, or a new alias ==
 * an existing slug) — the existing project is returned untouched with
 * `created: false`. The match check and the append share the same
 * per-workspace lock, so two concurrent add_project calls can't both
 * create the same slug.
 *
 * Matching mirrors the taxonomy reader's index (slug map + alias map
 * keyed by `normalizeAlias`) so "already maps to a project" means
 * exactly what `findProject()` would resolve at ingest time.
 */
export async function addProjectDeduped(
  paths: TaxonomyPaths,
  input: {
    slug: string;
    name?: string;
    description?: string;
    aliases?: string[];
    active?: boolean;
    people?: string[];
  },
): Promise<AddProjectResult> {
  return runLocked(paths.repoRoot, async () => {
    const projects = await readProjects(paths);

    const bySlug = new Map<string, Project>();
    const byAlias = new Map<string, Project>();
    for (const p of projects) {
      bySlug.set(p.slug, p);
      byAlias.set(normalizeAlias(p.name), p);
      for (const a of p.aliases) byAlias.set(normalizeAlias(a), p);
    }
    const resolve = (value: string): Project | undefined =>
      bySlug.get(value) ?? byAlias.get(normalizeAlias(value));

    const candidates: Array<{ kind: "slug" | "alias"; value: string }> = [
      { kind: "slug", value: input.slug },
      ...(input.aliases ?? []).map((value) => ({
        kind: "alias" as const,
        value,
      })),
    ];
    for (const candidate of candidates) {
      const hit = resolve(candidate.value);
      if (hit) return { project: hit, created: false, matchedOn: candidate };
    }

    const project: Project = {
      slug: input.slug,
      name: input.name ?? input.slug,
      description: input.description ?? "",
      active: input.active ?? true,
      aliases: input.aliases ?? [],
      people: input.people ?? [],
      sources: {},
    };
    projects.push(project);
    await writeProjects(paths, projects);
    return { project, created: true };
  });
}

/**
 * Clear `self: true` on any other person and set it on the given
 * slug. Used by update_user_identity so we maintain the invariant
 * that exactly one person is flagged as self. Serialized per-workspace.
 */
export async function markSelf(
  paths: TaxonomyPaths,
  slug: string,
): Promise<void> {
  await runLocked(paths.repoRoot, async () => {
    const people = await readPeople(paths);
    for (const p of people) {
      if (p.slug === slug) p.self = true;
      else if (p.self) p.self = false;
    }
    await writePeople(paths, people);
  });
}

function jobProfilePath(paths: TaxonomyPaths): string {
  return path.join(paths.repoRoot, "config", "job-profile.yaml");
}

/**
 * Read the workspace's job profile. Returns `undefined` when the file
 * is missing or the `profile` key is unset — `get_job_profile`
 * surfaces this as `configured: false` so the assistant can defer
 * interrogation until the user brings up something work-related.
 */
export async function readJobProfile(
  paths: TaxonomyPaths,
): Promise<JobProfile | undefined> {
  const filePath = await ensureLocalCopy(jobProfilePath(paths));
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const parsed = jobProfileFileSchema.parse(parseYaml(raw) ?? {});
  return parsed.profile;
}

/**
 * Upsert the workspace job profile. Patch semantics — only the supplied
 * fields overwrite; everything else is preserved. Serialized
 * per-workspace alongside the other taxonomy mutations.
 */
export async function upsertJobProfile(
  paths: TaxonomyPaths,
  patch: Partial<JobProfile>,
): Promise<JobProfile> {
  return runLocked(paths.repoRoot, async () => {
    const current = (await readJobProfile(paths)) ?? {
      focusAreas: [],
      stack: [],
      directReports: [],
    };
    const merged: JobProfile = {
      ...current,
      ...patch,
      focusAreas: patch.focusAreas ?? current.focusAreas,
      stack: patch.stack ?? current.stack,
      directReports: patch.directReports ?? current.directReports,
    };
    const filePath = await ensureLocalCopy(jobProfilePath(paths));
    const out = stringifyYaml(
      { profile: merged },
      { indent: 2, lineWidth: 0 },
    );
    await writeFile(filePath, out, "utf8");
    return merged;
  });
}
