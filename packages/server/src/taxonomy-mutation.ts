import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  peopleFileSchema,
  projectsFileSchema,
  type Person,
  type Project,
} from "@onenomad/cortex-core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ensureLocalCopy } from "./cli/config-mutation.js";

/**
 * Persistence helpers for the identity + taxonomy-gap MCP tools.
 *
 * Reads and writes go through `ensureLocalCopy` so edits land in the
 * `.local.yaml` overlay (the one the loader actually reads) rather
 * than the committed template.
 */

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
 * was newly created.
 */
export async function upsertPerson(
  paths: TaxonomyPaths,
  patch: Partial<Person> & { slug: string },
): Promise<{ person: Person; created: boolean }> {
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
}

/**
 * Upsert a project by slug. Same semantics as upsertPerson.
 */
export async function upsertProject(
  paths: TaxonomyPaths,
  patch: Partial<Project> & { slug: string },
): Promise<{ project: Project; created: boolean }> {
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
}

/**
 * Clear `self: true` on any other person and set it on the given
 * slug. Used by update_user_identity so we maintain the invariant
 * that exactly one person is flagged as self.
 */
export async function markSelf(
  paths: TaxonomyPaths,
  slug: string,
): Promise<void> {
  const people = await readPeople(paths);
  for (const p of people) {
    if (p.slug === slug) p.self = true;
    else if (p.self) p.self = false;
  }
  await writePeople(paths, people);
}
