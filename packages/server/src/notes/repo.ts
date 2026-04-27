import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  parseNote,
  serializeNote,
  type NoteFrontmatter,
  type ParsedNote,
} from "./frontmatter.js";
import { pickAvailableSlug, slugify } from "./slug.js";

/**
 * CRUD ops over `<vault>/<notesSubdir>/<slug>.md` files. The actual
 * vault path is provided by the caller (resolved from cortex.yaml's
 * obsidian config); this module is a pure file-layer over markdown +
 * frontmatter, no engram coupling. Tests inject a tmp dir as
 * `dir.notesDir`.
 */

export interface NotesRepo {
  /** Absolute path to the cortex-notes subdirectory inside the vault. */
  notesDir: string;
}

export interface CreateNoteInput {
  title: string;
  body: string;
  project?: string;
  tags?: string[];
  /** Inject for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface NoteHandle {
  slug: string;
  path: string;
}

export interface NoteSummary {
  slug: string;
  title: string;
  project?: string;
  tags?: string[];
  updated: string;
  preview: string;
}

const PREVIEW_CHARS = 200;

export function ensureNotesDir(repo: NotesRepo): void {
  if (!existsSync(repo.notesDir)) {
    mkdirSync(repo.notesDir, { recursive: true });
  }
}

function notePath(repo: NotesRepo, slug: string): string {
  return resolve(repo.notesDir, `${slug}.md`);
}

function noteExists(repo: NotesRepo, slug: string): boolean {
  return existsSync(notePath(repo, slug));
}

/** Atomically write `content` to `path` via tmp + rename. */
function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function createNote(repo: NotesRepo, input: CreateNoteInput): NoteHandle {
  ensureNotesDir(repo);
  const now = (input.now ?? (() => new Date()))().toISOString();
  const baseSlug = slugify(input.title);
  const slug = pickAvailableSlug(baseSlug, (s) => noteExists(repo, s));
  const fm: NoteFrontmatter = {
    slug,
    title: input.title,
    ...(input.project !== undefined ? { project: input.project } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    created: now,
    updated: now,
    source: "cortex-notes",
  };
  const path = notePath(repo, slug);
  atomicWrite(path, serializeNote(fm, input.body));
  return { slug, path };
}

export interface UpdateNoteInput {
  slug: string;
  title?: string;
  body?: string;
  project?: string;
  tags?: string[];
  now?: () => Date;
}

export interface UpdateNoteResult {
  slug: string;
  path: string;
  /** True when the file actually changed; false when the patch was a no-op. */
  changed: boolean;
}

export function updateNote(repo: NotesRepo, input: UpdateNoteInput): UpdateNoteResult {
  const path = notePath(repo, input.slug);
  if (!existsSync(path)) {
    throw new Error(`note: '${input.slug}' not found`);
  }
  const existing = parseNote(readFileSync(path, "utf8"));
  const next: NoteFrontmatter = {
    ...existing.frontmatter,
    slug: input.slug,
    source: "cortex-notes",
  };
  if (input.title !== undefined) next.title = input.title;
  if (input.project !== undefined) next.project = input.project;
  if (input.tags !== undefined) next.tags = input.tags;
  const nextBody = input.body !== undefined ? input.body : existing.body;
  const trialContent = serializeNote(next, nextBody);
  // Idempotent — if title/project/tags/body are all unchanged, the
  // serialized content (modulo the soon-to-be-bumped `updated`)
  // matches what's on disk. Compare BEFORE bumping `updated` so an
  // identical save doesn't churn the file.
  const beforeBumped = serializeNote(
    { ...next, updated: existing.frontmatter.updated },
    nextBody,
  );
  const onDisk = readFileSync(path, "utf8");
  if (beforeBumped === onDisk) {
    return { slug: input.slug, path, changed: false };
  }
  const now = (input.now ?? (() => new Date()))().toISOString();
  next.updated = now;
  atomicWrite(path, serializeNote(next, nextBody));
  return { slug: input.slug, path, changed: true };
}

export function deleteNote(repo: NotesRepo, slug: string): { slug: string; path: string; deleted: boolean } {
  const path = notePath(repo, slug);
  if (!existsSync(path)) {
    return { slug, path, deleted: false };
  }
  rmSync(path);
  return { slug, path, deleted: true };
}

export function listNotes(
  repo: NotesRepo,
  opts: { project?: string; limit?: number } = {},
): NoteSummary[] {
  if (!existsSync(repo.notesDir)) return [];
  const entries = readdirSync(repo.notesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"));
  const out: NoteSummary[] = [];
  for (const entry of entries) {
    const path = join(repo.notesDir, entry.name);
    let parsed: ParsedNote;
    try {
      parsed = parseNote(readFileSync(path, "utf8"));
    } catch {
      // Skip files we can't parse — could be a non-cortex-notes
      // markdown that happens to live in the subdir.
      continue;
    }
    if (parsed.frontmatter.source !== "cortex-notes") continue;
    if (opts.project && parsed.frontmatter.project !== opts.project) continue;
    const summary: NoteSummary = {
      slug: parsed.frontmatter.slug,
      title: parsed.frontmatter.title,
      updated: parsed.frontmatter.updated,
      preview: previewBody(parsed.body),
    };
    if (parsed.frontmatter.project !== undefined) summary.project = parsed.frontmatter.project;
    if (parsed.frontmatter.tags !== undefined) summary.tags = parsed.frontmatter.tags;
    out.push(summary);
  }
  out.sort((a, b) => b.updated.localeCompare(a.updated));
  if (opts.limit !== undefined) return out.slice(0, opts.limit);
  return out;
}

function previewBody(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= PREVIEW_CHARS) return oneLine;
  return `${oneLine.slice(0, PREVIEW_CHARS - 1).trimEnd()}…`;
}
