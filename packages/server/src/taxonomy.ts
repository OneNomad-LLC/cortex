import { readFile } from "node:fs/promises";
import {
  normalizeAlias,
  peopleFileSchema,
  projectsFileSchema,
  type Person,
  type Project,
  type TaxonomyReader,
} from "@onenomad/cortex-core";
import { parse as parseYaml } from "yaml";
import { resolveLocalFirst } from "./config.js";

export interface LoadedTaxonomy extends TaxonomyReader {
  readonly projects: ReadonlyArray<Project>;
  readonly people: ReadonlyArray<Person>;
}

/**
 * Load projects.yaml and people.yaml and return a reader over the result.
 * Missing files yield an empty taxonomy — that's expected until the user
 * fills them in.
 */
export async function loadTaxonomy(args: {
  projectsPath: string;
  peoplePath: string;
}): Promise<LoadedTaxonomy> {
  const projects = await loadProjects(args.projectsPath);
  const people = await loadPeople(args.peoplePath);
  return buildReader(projects, people);
}

async function loadProjects(path: string): Promise<Project[]> {
  const raw = await tryRead(path);
  if (raw === undefined) return [];
  const parsed = projectsFileSchema.parse(parseYaml(raw) ?? {});
  return parsed.projects;
}

async function loadPeople(path: string): Promise<Person[]> {
  const raw = await tryRead(path);
  if (raw === undefined) return [];
  const parsed = peopleFileSchema.parse(parseYaml(raw) ?? {});
  return parsed.people;
}

async function tryRead(path: string): Promise<string | undefined> {
  // Prefer `<name>.local.yaml` over the committed template. Same rule as
  // cortex.yaml — real data stays out of git. See docs/PRIVACY.md.
  const resolved = await resolveLocalFirst(path);
  try {
    return await readFile(resolved, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function buildReader(
  projects: Project[],
  people: Person[],
): LoadedTaxonomy {
  // Pre-index for lookups. Built once at load; cheap enough to rebuild on
  // config reload.
  const projectBySlug = new Map<string, Project>();
  const projectByAlias = new Map<string, Project>();
  for (const p of projects) {
    projectBySlug.set(p.slug, p);
    projectByAlias.set(normalizeAlias(p.name), p);
    for (const alias of p.aliases) {
      projectByAlias.set(normalizeAlias(alias), p);
    }
  }

  const personBySlug = new Map<string, Person>();
  const personByEmail = new Map<string, Person>();
  const personByName = new Map<string, Person>();
  for (const p of people) {
    personBySlug.set(p.slug, p);
    personByEmail.set(p.email.toLowerCase(), p);
    personByName.set(normalizeAlias(p.name), p);
    for (const alias of p.aliases) {
      personByName.set(normalizeAlias(alias), p);
    }
  }

  return {
    projects,
    people,

    listProjects(opts) {
      const active = opts?.activeOnly ?? false;
      return active ? projects.filter((p) => p.active) : [...projects];
    },

    findProjectBySlug(slug) {
      return projectBySlug.get(slug);
    },

    findProject(query) {
      const direct = projectBySlug.get(query);
      if (direct) return direct;
      return projectByAlias.get(normalizeAlias(query));
    },

    listPeople() {
      return [...people];
    },

    findPersonBySlug(slug) {
      return personBySlug.get(slug);
    },

    findPersonByEmail(email) {
      return personByEmail.get(email.toLowerCase());
    },

    findPerson(query) {
      const direct = personBySlug.get(query);
      if (direct) return direct;
      const byEmail = personByEmail.get(query.toLowerCase());
      if (byEmail) return byEmail;
      return personByName.get(normalizeAlias(query));
    },
  };
}
