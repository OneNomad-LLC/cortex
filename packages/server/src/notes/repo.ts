import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter as parseLooseFrontmatter } from "@onenomad/przm-cortex-adapter-obsidian";
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
 *
 * Listing federates over both surfaces:
 *   - `cortex` notes: editable from the dashboard, written to the
 *     cortex-notes subdir with a strict frontmatter contract.
 *   - `obsidian` notes: read-only — anywhere else in the vault, with
 *     loose frontmatter (whatever Obsidian writes). The dashboard
 *     surfaces these so the user sees a single unified list.
 */

export interface NotesRepo {
  /**
   * Absolute path to the obsidian vault root. When omitted, the
   * federated listing skips the obsidian walk and only returns
   * cortex-authored notes — used by unit tests that don't care
   * about the broader vault.
   */
  vaultPath?: string;
  /** Absolute path to the cortex-notes subdirectory inside the vault. */
  notesDir: string;
  /** Directory names to skip during the vault walk (`.obsidian`, etc.). */
  ignoreDirs?: ReadonlySet<string>;
}

const DEFAULT_IGNORE = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const PREVIEW_CHARS = 200;
const MAX_FILE_BYTES = 1_048_576;

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
  /**
   * Stable identifier for the note. For cortex notes this is the
   * slug from frontmatter (and also `<slug>.md` filename). For
   * obsidian notes this is the vault-relative POSIX path with the
   * `.md` extension stripped — used to fetch the body via note_get.
   */
  id: string;
  /**
   * Backwards-compat: cortex notes still expose a `slug` field
   * matching `id`. Obsidian notes leave it undefined — the dashboard
   * keys on `id` for both kinds.
   */
  slug?: string;
  title: string;
  project?: string;
  tags?: string[];
  updated: string;
  preview: string;
  /**
   * `cortex` — round-trippable through the dashboard editor (lives
   * in the cortex-notes subdir with our strict frontmatter).
   * `obsidian` — read-only; user authored elsewhere in the vault.
   */
  kind: "cortex" | "obsidian";
  /** Vault-relative POSIX path. Only set for obsidian-kind notes. */
  relativePath?: string;
}

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

/**
 * Federated listing across the whole vault.
 *
 *   cortex/<slug>.md  — strict frontmatter, dashboard-editable
 *   anywhere else      — loose frontmatter, read-only in dashboard
 *
 * Cortex notes are cheap to list (one flat dir, strict shape).
 * Obsidian notes require a recursive walk; we cap at `MAX_FILE_BYTES`
 * to skip huge dumps and respect `ignoreDirs` so we don't recurse
 * into `.obsidian/` plugin junk.
 */
export function listNotes(
  repo: NotesRepo,
  opts: { project?: string; limit?: number } = {},
): NoteSummary[] {
  const out: NoteSummary[] = [];
  const ignore = repo.ignoreDirs ?? DEFAULT_IGNORE;

  // Cortex-authored notes (existing behavior, now tagged kind=cortex).
  if (existsSync(repo.notesDir)) {
    const entries = readdirSync(repo.notesDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"));
    for (const entry of entries) {
      const path = join(repo.notesDir, entry.name);
      let parsed: ParsedNote;
      try {
        parsed = parseNote(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      if (parsed.frontmatter.source !== "cortex-notes") continue;
      if (opts.project && parsed.frontmatter.project !== opts.project) continue;
      const summary: NoteSummary = {
        id: parsed.frontmatter.slug,
        slug: parsed.frontmatter.slug,
        title: parsed.frontmatter.title,
        updated: parsed.frontmatter.updated,
        preview: previewBody(parsed.body),
        kind: "cortex",
      };
      if (parsed.frontmatter.project !== undefined) summary.project = parsed.frontmatter.project;
      if (parsed.frontmatter.tags !== undefined) summary.tags = parsed.frontmatter.tags;
      out.push(summary);
    }
  }

  // Obsidian-authored notes everywhere else in the vault.
  if (repo.vaultPath && existsSync(repo.vaultPath)) {
    const cortexNotesAbs = resolve(repo.notesDir);
    walkVaultSync(repo.vaultPath, ignore, (abs, relPosix, mtimeMs, size) => {
      if (size > MAX_FILE_BYTES) return;
      // Skip the cortex-notes subdir — already covered above with
      // strict parsing. Loose-parsing it would double-count.
      if (abs === cortexNotesAbs || abs.startsWith(`${cortexNotesAbs}${sep}`)) {
        return;
      }
      let raw: string;
      try {
        raw = readFileSync(abs, "utf8");
      } catch {
        return;
      }
      const { metadata, body } = parseLooseFrontmatter(raw);
      const project = scalar(metadata.project);
      if (opts.project && project !== opts.project) return;
      const tags = listFromMeta(metadata.tags);
      const idFromPath = relPosix.replace(/\.md$/i, "");
      const summary: NoteSummary = {
        id: idFromPath,
        title: scalar(metadata.title) ?? fileBaseName(relPosix),
        updated: new Date(mtimeMs).toISOString(),
        preview: previewBody(body || raw),
        kind: "obsidian",
        relativePath: relPosix,
      };
      if (project !== undefined) summary.project = project;
      if (tags.length > 0) summary.tags = tags;
      out.push(summary);
    });
  }

  out.sort((a, b) => b.updated.localeCompare(a.updated));
  if (opts.limit !== undefined) return out.slice(0, opts.limit);
  return out;
}

export interface NoteRef {
  kind: "cortex" | "obsidian";
  /** For cortex notes — slug. */
  slug?: string;
  /** For obsidian notes — vault-relative POSIX path. */
  relativePath?: string;
}

export interface NoteRead {
  id: string;
  kind: "cortex" | "obsidian";
  title: string;
  body: string;
  project?: string;
  tags?: string[];
  updated: string;
  /** Vault-relative POSIX path. Always set so the UI can deep-link. */
  relativePath: string;
}

/**
 * Read the full body + metadata of a single note. The dashboard
 * editor needs this — `listNotes` only returns previews.
 *
 * Throws when the file is missing or unreadable.
 */
export function getNote(repo: NotesRepo, ref: NoteRef): NoteRead {
  if (ref.kind === "cortex") {
    if (!ref.slug) throw new Error("note_get: slug required for cortex notes");
    const abs = resolve(repo.notesDir, `${ref.slug}.md`);
    if (!existsSync(abs)) throw new Error(`note_get: '${ref.slug}' not found`);
    const parsed = parseNote(readFileSync(abs, "utf8"));
    const out: NoteRead = {
      id: parsed.frontmatter.slug,
      kind: "cortex",
      title: parsed.frontmatter.title,
      body: parsed.body,
      updated: parsed.frontmatter.updated,
      relativePath: repo.vaultPath
        ? posixRel(repo.vaultPath, abs)
        : `${ref.slug}.md`,
    };
    if (parsed.frontmatter.project !== undefined) out.project = parsed.frontmatter.project;
    if (parsed.frontmatter.tags !== undefined) out.tags = parsed.frontmatter.tags;
    return out;
  }
  // obsidian
  if (!repo.vaultPath) {
    throw new Error("note_get: vaultPath not configured — obsidian adapter required");
  }
  if (!ref.relativePath) throw new Error("note_get: relativePath required for obsidian notes");
  if (!isSafeRelativePath(ref.relativePath)) {
    throw new Error("note_get: invalid relativePath");
  }
  const vaultRoot = resolve(repo.vaultPath);
  const abs = resolve(vaultRoot, ref.relativePath);
  if (!abs.startsWith(vaultRoot)) {
    throw new Error("note_get: relativePath escapes the vault");
  }
  if (!existsSync(abs)) throw new Error(`note_get: '${ref.relativePath}' not found`);
  const raw = readFileSync(abs, "utf8");
  const { metadata, body } = parseLooseFrontmatter(raw);
  const stat = statSync(abs);
  const project = scalar(metadata.project);
  const tags = listFromMeta(metadata.tags);
  const out: NoteRead = {
    id: ref.relativePath.replace(/\.md$/i, ""),
    kind: "obsidian",
    title: scalar(metadata.title) ?? fileBaseName(ref.relativePath),
    body: body || raw,
    updated: new Date(stat.mtimeMs).toISOString(),
    relativePath: ref.relativePath,
  };
  if (project !== undefined) out.project = project;
  if (tags.length > 0) out.tags = tags;
  return out;
}

function previewBody(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= PREVIEW_CHARS) return oneLine;
  return `${oneLine.slice(0, PREVIEW_CHARS - 1).trimEnd()}…`;
}

function posixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function fileBaseName(relPosix: string): string {
  const last = relPosix.split("/").pop() ?? relPosix;
  return last.replace(/\.md$/i, "");
}

function scalar(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function listFromMeta(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

/**
 * Reject inputs that would let a caller break out of the vault.
 * - absolute paths (`/foo`, `C:\foo`)
 * - any `..` segment
 * - backslashes (caller must send POSIX form)
 */
function isSafeRelativePath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "..") return false;
  }
  return true;
}

/**
 * Synchronous recursive walker. Sync I/O is fine — the dashboard
 * `note_list` is a low-frequency human-driven call and a typical
 * vault is hundreds, not millions, of files. Stays sync to avoid
 * an async fan-out for what's effectively a single screen render.
 */
function walkVaultSync(
  root: string,
  ignore: ReadonlySet<string>,
  visit: (abs: string, relPosix: string, mtimeMs: number, sizeBytes: number) => void,
): void {
  function recurse(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      let info;
      try {
        info = statSync(abs);
      } catch {
        continue;
      }
      visit(abs, posixRel(root, abs), info.mtimeMs, info.size);
    }
  }
  recurse(root);
}
