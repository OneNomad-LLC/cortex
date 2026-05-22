import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type {
  AdrFile,
  CodeDossierInput,
  CodeDossierPipelineOptions,
  EntryPointFile,
  ManifestFile,
  StructuralPayload,
} from "./types.js";

const README_CANDIDATES = ["README.md", "README.rst", "README.txt"] as const;
const ARCHITECTURE_CANDIDATES = ["ARCHITECTURE.md", "ARCHITECTURE.rst"] as const;
const CLAUDE_CANDIDATES = ["CLAUDE.md"] as const;
const AGENTS_CANDIDATES = ["AGENTS.md"] as const;
const DECISIONS_CANDIDATES = [
  "docs/DECISIONS.md",
  "docs/decisions.md",
] as const;
const ROADMAP_CANDIDATES = ["docs/ROADMAP.md", "ROADMAP.md"] as const;
const MIGRATION_CANDIDATES = ["docs/MIGRATION.md", "MIGRATION.md"] as const;
const CHANGELOG_CANDIDATES = ["CHANGELOG.md"] as const;

/**
 * Manifest detection — the FIRST EXISTING file wins. JSON manifests get
 * a `parsed` payload so prompt rendering can read fields like
 * "scripts" or "bin" without re-parsing.
 */
const MANIFEST_CANDIDATES = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "Gemfile",
  "go.mod",
] as const;

const MONOREPO_MANIFEST_CANDIDATES = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "turbo.json",
] as const;

/**
 * Root entry-point detection — FIRST EXISTING wins. Picking just one
 * keeps the prompt budget tight and avoids a Python+Go+Rust salad on
 * polyglot repos.
 */
const ROOT_ENTRY_POINT_CANDIDATES = [
  "src/index.ts",
  "src/index.js",
  "src/main.ts",
  "src/main.js",
  "src/lib.rs",
  "src/main.rs",
  "main.go",
  "lib/index.ts",
  "index.ts",
  "index.js",
] as const;

/**
 * Per-monorepo-package entry points: only one level deep. For a typical
 * pnpm workspace this hits each packages-slash-name-slash-src-index.ts
 * (i.e. one canonical entry per first-level subpackage).
 */
const SUBPACKAGE_ENTRY_POINT_CANDIDATES = [
  "src/index.ts",
  "src/index.js",
  "src/main.ts",
  "index.ts",
  "index.js",
] as const;

interface BuildOptions {
  readonly maxStructuralPayloadChars: number;
  readonly maxEntryPointChars: number;
  readonly maxTextFileChars: number;
  readonly maxEntryPoints: number;
  readonly maxAdrFiles: number;
}

function resolveOptions(
  opts: CodeDossierPipelineOptions = {},
): BuildOptions {
  return {
    maxStructuralPayloadChars: opts.maxStructuralPayloadChars ?? 200_000,
    maxEntryPointChars: opts.maxEntryPointChars ?? 10_000,
    maxTextFileChars: opts.maxTextFileChars ?? 50_000,
    maxEntryPoints: opts.maxEntryPoints ?? 12,
    maxAdrFiles: opts.maxAdrFiles ?? 50,
  };
}

/**
 * Pass 1 — pure file walk, no LLM. Reads the canonical "tell me about
 * this repo" files when present, samples entry points, and returns a
 * sized payload suitable for feeding into the synthesis prompt.
 *
 * Missing files yield empty strings — downstream prompts use that to
 * decide whether to even include a section.
 */
export async function buildStructuralPayload(
  input: CodeDossierInput,
  opts: CodeDossierPipelineOptions = {},
): Promise<StructuralPayload> {
  const o = resolveOptions(opts);
  const root = input.repoPath;
  const repoName = deriveRepoName(input);

  // Load the simple "first existing" docs in parallel.
  const [
    readme,
    architecture,
    claudeMd,
    agentsMd,
    decisions,
    roadmap,
    migration,
    changelog,
  ] = await Promise.all([
    readFirstExisting(root, README_CANDIDATES, o.maxTextFileChars),
    readFirstExisting(root, ARCHITECTURE_CANDIDATES, o.maxTextFileChars),
    readFirstExisting(root, CLAUDE_CANDIDATES, o.maxTextFileChars),
    readFirstExisting(root, AGENTS_CANDIDATES, o.maxTextFileChars),
    readFirstExisting(root, DECISIONS_CANDIDATES, o.maxTextFileChars),
    readFirstExisting(root, ROADMAP_CANDIDATES, o.maxTextFileChars),
    readFirstExisting(root, MIGRATION_CANDIDATES, o.maxTextFileChars),
    readFirstExisting(root, CHANGELOG_CANDIDATES, o.maxTextFileChars),
  ]);

  const adrFiles = await collectAdrFiles(root, o.maxAdrFiles, o.maxTextFileChars);

  const manifest = await readFirstManifest(
    root,
    MANIFEST_CANDIDATES,
    o.maxTextFileChars,
  );
  const monorepoManifest = await readFirstManifest(
    root,
    MONOREPO_MANIFEST_CANDIDATES,
    o.maxTextFileChars,
  );

  const entryPoints = await collectEntryPoints(
    root,
    manifest,
    o.maxEntryPoints,
    o.maxEntryPointChars,
  );

  const payload: StructuralPayload = {
    repoName,
    readme,
    architecture,
    claudeMd,
    agentsMd,
    decisions,
    adrFiles,
    roadmap,
    migration,
    changelog,
    manifest,
    monorepoManifest,
    entryPoints,
  };

  // Enforce overall payload budget. Trim the lowest-signal fields first
  // (changelog → migration → roadmap → entry-point bodies). Strict trim
  // because downstream LLM cost is real money.
  return enforceBudget(payload, o.maxStructuralPayloadChars);
}

function deriveRepoName(input: CodeDossierInput): string {
  // Prefer the trailing segment of the source-id prefix
  // (e.g. "github:OneNomad-LLC/cortex" -> "cortex"). Fall back to the
  // basename of the repo path so we always have something printable.
  const colonIdx = input.sourceIdPrefix.lastIndexOf(":");
  const tail =
    colonIdx >= 0
      ? input.sourceIdPrefix.slice(colonIdx + 1)
      : input.sourceIdPrefix;
  const slashIdx = tail.lastIndexOf("/");
  const fromPrefix = slashIdx >= 0 ? tail.slice(slashIdx + 1) : tail;
  if (fromPrefix.trim().length > 0) return fromPrefix;
  return path.basename(path.resolve(input.repoPath));
}

async function readFirstExisting(
  root: string,
  candidates: ReadonlyArray<string>,
  capChars: number,
): Promise<string> {
  for (const rel of candidates) {
    const full = path.join(root, rel);
    const text = await readFileSafe(full, capChars);
    if (text !== null) return text;
  }
  return "";
}

async function readFirstManifest(
  root: string,
  candidates: ReadonlyArray<string>,
  capChars: number,
): Promise<ManifestFile | null> {
  for (const rel of candidates) {
    const full = path.join(root, rel);
    const text = await readFileSafe(full, capChars);
    if (text === null) continue;
    let parsed: Record<string, unknown> | null = null;
    if (rel.endsWith(".json")) {
      try {
        const candidate: unknown = JSON.parse(text);
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          parsed = candidate as Record<string, unknown>;
        }
      } catch {
        // Malformed JSON: store the raw text but leave parsed null.
        parsed = null;
      }
    }
    return { filename: rel, content: text, parsed };
  }
  return null;
}

async function readFileSafe(
  full: string,
  capChars: number,
): Promise<string | null> {
  try {
    const text = await readFile(full, "utf8");
    return truncate(text, capChars);
  } catch (err) {
    if (isEnoent(err)) return null;
    // Unreadable but present (permission denied, encoding error). Treat
    // as absent rather than throwing — Pass 1 is best-effort by design.
    return null;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

function truncate(text: string, capChars: number): string {
  if (text.length <= capChars) return text;
  const marker = "\n\n... [truncated by pipeline-code-dossier] ...";
  return text.slice(0, Math.max(0, capChars - marker.length)) + marker;
}

async function collectAdrFiles(
  root: string,
  maxFiles: number,
  capChars: number,
): Promise<AdrFile[]> {
  const docsDir = path.join(root, "docs");
  let entries: string[];
  try {
    entries = await readdir(docsDir);
  } catch {
    return [];
  }

  const adrs = entries
    .filter((name) => /^ADR[-_]?\d+.*\.(md|markdown)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .slice(0, maxFiles);

  const results: AdrFile[] = [];
  for (const filename of adrs) {
    const rel = path.join("docs", filename);
    const full = path.join(root, rel);
    const content = await readFileSafe(full, capChars);
    if (content === null) continue;
    results.push({ filename, path: rel, content });
  }
  return results;
}

async function collectEntryPoints(
  root: string,
  manifest: ManifestFile | null,
  maxFiles: number,
  capChars: number,
): Promise<EntryPointFile[]> {
  const seen = new Set<string>();
  const out: EntryPointFile[] = [];

  // 1. Root-level "first existing" entry point.
  for (const rel of ROOT_ENTRY_POINT_CANDIDATES) {
    if (out.length >= maxFiles) break;
    const text = await readFileSafe(path.join(root, rel), capChars);
    if (text === null) continue;
    if (!seen.has(rel)) {
      seen.add(rel);
      out.push({ path: rel, content: text });
    }
    // FIRST EXISTING — stop after the first hit.
    break;
  }

  // 2. bin/* files declared in package.json.
  const binPaths = collectBinPaths(manifest);
  for (const rel of binPaths) {
    if (out.length >= maxFiles) break;
    if (seen.has(rel)) continue;
    const text = await readFileSafe(path.join(root, rel), capChars);
    if (text === null) continue;
    seen.add(rel);
    out.push({ path: rel, content: text });
  }

  // 3. Monorepo: one entry point per packages/* (single level deep).
  const subpackages = await listSubpackages(root);
  for (const pkgRel of subpackages) {
    if (out.length >= maxFiles) break;
    for (const candidate of SUBPACKAGE_ENTRY_POINT_CANDIDATES) {
      const rel = path.join(pkgRel, candidate);
      if (seen.has(rel)) continue;
      const text = await readFileSafe(path.join(root, rel), capChars);
      if (text === null) continue;
      seen.add(rel);
      out.push({ path: rel, content: text });
      break; // first existing for this subpackage
    }
  }

  return out;
}

function collectBinPaths(manifest: ManifestFile | null): string[] {
  if (!manifest || !manifest.parsed) return [];
  const bin = manifest.parsed.bin;
  if (typeof bin === "string") return [bin];
  if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    return Object.values(bin as Record<string, unknown>).filter(
      (v): v is string => typeof v === "string",
    );
  }
  return [];
}

async function listSubpackages(root: string): Promise<string[]> {
  const packagesDir = path.join(root, "packages");
  let entries: Dirent[];
  try {
    entries = (await readdir(packagesDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = String(e.name);
    if (name.startsWith(".")) continue;
    out.push(path.join("packages", name));
  }
  out.sort();
  return out;
}

/**
 * Enforce a hard char budget across the whole structural payload. We
 * trim the bulkiest, lowest-signal fields first so the synthesis prompt
 * keeps the most useful materials intact.
 */
function enforceBudget(
  payload: StructuralPayload,
  budgetChars: number,
): StructuralPayload {
  type TrimmableField =
    | "readme"
    | "architecture"
    | "claudeMd"
    | "agentsMd"
    | "decisions"
    | "roadmap"
    | "migration"
    | "changelog";

  const trimOrder: ReadonlyArray<TrimmableField> = [
    "changelog",
    "migration",
    "roadmap",
    "decisions",
    "agentsMd",
    "claudeMd",
  ];

  const mutable: Record<TrimmableField, string> & { entryPoints: EntryPointFile[] } = {
    readme: payload.readme,
    architecture: payload.architecture,
    claudeMd: payload.claudeMd,
    agentsMd: payload.agentsMd,
    decisions: payload.decisions,
    roadmap: payload.roadmap,
    migration: payload.migration,
    changelog: payload.changelog,
    entryPoints: payload.entryPoints.map((e) => ({ ...e })),
  };

  const measure = (): number => {
    let total = 0;
    total += mutable.readme.length;
    total += mutable.architecture.length;
    total += mutable.claudeMd.length;
    total += mutable.agentsMd.length;
    total += mutable.decisions.length;
    total += mutable.roadmap.length;
    total += mutable.migration.length;
    total += mutable.changelog.length;
    for (const adr of payload.adrFiles) total += adr.content.length;
    for (const ep of mutable.entryPoints) total += ep.content.length;
    if (payload.manifest) total += payload.manifest.content.length;
    if (payload.monorepoManifest) total += payload.monorepoManifest.content.length;
    return total;
  };

  for (const field of trimOrder) {
    if (measure() <= budgetChars) break;
    if (mutable[field].length > 0) {
      mutable[field] = "";
    }
  }

  // Last resort: trim entry-point bodies (keep the path metadata).
  if (measure() > budgetChars) {
    const overshoot = measure() - budgetChars;
    let remaining = overshoot;
    for (let i = mutable.entryPoints.length - 1; i >= 0 && remaining > 0; i--) {
      const ep = mutable.entryPoints[i];
      if (!ep) continue;
      const cutTo = Math.max(0, ep.content.length - remaining);
      remaining -= ep.content.length - cutTo;
      mutable.entryPoints[i] = { path: ep.path, content: ep.content.slice(0, cutTo) };
    }
  }

  return {
    ...payload,
    readme: mutable.readme,
    architecture: mutable.architecture,
    claudeMd: mutable.claudeMd,
    agentsMd: mutable.agentsMd,
    decisions: mutable.decisions,
    roadmap: mutable.roadmap,
    migration: mutable.migration,
    changelog: mutable.changelog,
    entryPoints: mutable.entryPoints,
  };
}

/**
 * Stable representation of an entry point for prompt rendering. Each
 * file is wrapped in fenced source blocks with a path header so the
 * model can attribute claims to specific files.
 */
export function renderEntryPointsForPrompt(
  entryPoints: ReadonlyArray<EntryPointFile>,
): string {
  if (entryPoints.length === 0) return "";
  return entryPoints
    .map((ep) => {
      const lang = guessFenceLanguage(ep.path);
      const fence = "```";
      return `### ${ep.path}\n\n${fence}${lang}\n${ep.content}\n${fence}`;
    })
    .join("\n\n");
}

/**
 * Stable representation of the ADR set for prompt rendering. Concatenated
 * with file-name headers; downstream prompts can grep for an ADR by name.
 */
export function renderAdrsForPrompt(adrs: ReadonlyArray<AdrFile>): string {
  if (adrs.length === 0) return "";
  return adrs.map((a) => `### ${a.path}\n\n${a.content}`).join("\n\n");
}

/**
 * Compact ADR list for the Pass 3 prompt — filename + first heading, no
 * body. Pass 3 only needs enough to verify citations, not to re-read
 * every ADR.
 */
export function renderAdrList(adrs: ReadonlyArray<AdrFile>): string {
  if (adrs.length === 0) return "(no ADRs in repo)";
  return adrs
    .map((a) => {
      const heading = extractFirstHeading(a.content) ?? a.filename;
      return `- ${a.filename} — ${heading}`;
    })
    .join("\n");
}

function extractFirstHeading(text: string): string | null {
  const match = /^\s*#+\s+(.+?)\s*$/m.exec(text);
  return match?.[1] ?? null;
}

function guessFenceLanguage(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "ts";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".py":
      return "python";
    case ".rb":
      return "ruby";
    case ".java":
      return "java";
    case ".kt":
      return "kotlin";
    case ".md":
      return "markdown";
    default:
      return "";
  }
}

