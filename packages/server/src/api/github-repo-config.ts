/**
 * Helpers that read + mutate the `adapters.github.config.repos` list in
 * a workspace's cortex.yaml. Used by both the dashboard REST API
 * (routes/dashboard-github-repos.ts) and the `cortex_github_ingest_repo`
 * MCP tool so the two surfaces stay in lock-step.
 *
 * We do NOT touch the live `GithubAdapter` instance — adapter config is
 * the source of truth, and a server reload (`tryReload`) wires the new
 * value through the live registry. That matches the rest of cortex's
 * "config files are authoritative, in-memory state is rebuilt from
 * them" model (see dashboard-adapters.ts).
 *
 * The github adapter entry is auto-created the first time a repo is
 * added so the dashboard / MCP tool can connect a repo without forcing
 * the user to also run a separate "enable github adapter" step. The
 * entry shape mirrors `buildAdapterEntry()` in config-mutation.ts so
 * the wizard renderer still works on the resulting YAML.
 */

import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ensureLocalCopy } from "../cli/config-mutation.js";

export interface ParsedRepoIdentifier {
  owner: string;
  name: string;
}

/**
 * Best-effort coercion of the strings users actually paste into chat:
 *   - `owner/name`
 *   - `https://github.com/owner/name` (with or without `.git`)
 *   - `git@github.com:owner/name.git`
 * Returns null on anything malformed. We deliberately do NOT accept
 * tree URLs or refs — the slug is what the adapter keys off, so we
 * normalize to a plain owner/name pair.
 */
export function parseRepoIdentifier(
  input: string,
): ParsedRepoIdentifier | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Plain owner/name. The slug rule matches GitHub's own — letters,
  // digits, dot, underscore, hyphen — for both the owner and the repo.
  const plain = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(trimmed);
  if (plain) {
    const owner = plain[1]!;
    const name = plain[2]!;
    if (owner.length > 0 && name.length > 0) return { owner, name };
    return null;
  }

  // https://github.com/owner/name[.git]
  const https = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(
    trimmed,
  );
  if (https) {
    return { owner: https[1]!, name: https[2]! };
  }

  // git@github.com:owner/name(.git)?
  const ssh = /^git@github\.com:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/i.exec(
    trimmed,
  );
  if (ssh) {
    return { owner: ssh[1]!, name: ssh[2]! };
  }

  // ssh://git@github.com[:port]/owner/name(.git)?
  const sshLong = /^ssh:\/\/git@github\.com(?::\d+)?\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(
    trimmed,
  );
  if (sshLong) {
    return { owner: sshLong[1]!, name: sshLong[2]! };
  }

  return null;
}

/**
 * Read the current `adapters.github.config.repos` list. Returns an
 * empty array if cortex.yaml is missing, the github adapter isn't
 * configured, or the repos list isn't an array yet. Resolves against
 * cortex.local.yaml first when present so we read the same overlay
 * the rest of the dashboard mutates.
 */
export async function readGithubRepoList(
  configPath: string,
): Promise<string[]> {
  const effectivePath = await pickLocalOrBase(configPath);
  let raw: string;
  try {
    raw = await readFile(effectivePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const list = extractRepos(parsed);
  return list;
}

function extractRepos(doc: Record<string, unknown>): string[] {
  const adapters = doc.adapters as Record<string, unknown> | undefined;
  const github = adapters?.github as Record<string, unknown> | undefined;
  const cfg = github?.config as Record<string, unknown> | undefined;
  const repos = cfg?.repos;
  if (!Array.isArray(repos)) return [];
  const out: string[] = [];
  for (const entry of repos) {
    if (typeof entry === "string" && entry.length > 0) out.push(entry);
  }
  return out;
}

/**
 * Append `<owner>/<name>` to `adapters.github.config.repos` in
 * cortex.yaml. Idempotent — already-present entries return
 * `{added: false}`. Creates the github adapter entry if missing so
 * the dashboard can connect a repo as a single user step. Writes
 * through the .local overlay so the change survives template
 * rewrites. Caller is responsible for triggering a reload after.
 */
export async function appendGithubRepo(
  configPath: string,
  fullName: string,
): Promise<{ added: boolean }> {
  // `ensureLocalCopy` copies the committed template into
  // cortex.local.yaml on first touch — without it the very first
  // "connect github" would write a partial file with no adapters
  // section, losing whatever the user had configured in the template.
  const targetPath = await ensureLocalCopy(configPath);
  let raw: string;
  try {
    raw = await readFile(targetPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = "";
    else throw err;
  }
  const doc = (raw.trim().length > 0 ? (parseYaml(raw) ?? {}) : {}) as Record<
    string,
    unknown
  >;
  const adapters = ((doc.adapters as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  const github = ((adapters.github as Record<string, unknown>) ?? {
    package: "@onenomad/przm-cortex-adapter-github",
    enabled: true,
    config: {},
  }) as Record<string, unknown>;
  // If we just minted a fresh entry, surface it as enabled so the
  // sync that lands right after this write actually runs. A merge-
  // with-existing path preserves whatever the user had set.
  if (typeof github.package !== "string") {
    github.package = "@onenomad/przm-cortex-adapter-github";
  }
  if (typeof github.enabled !== "boolean") {
    github.enabled = true;
  }
  const cfg = ((github.config as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  const repos = Array.isArray(cfg.repos)
    ? ([...cfg.repos] as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  if (repos.includes(fullName)) {
    // Idempotent — nothing to write, no reload needed.
    return { added: false };
  }
  repos.push(fullName);
  cfg.repos = repos;
  github.config = cfg;
  adapters.github = github;
  doc.adapters = adapters;
  await writeFile(targetPath, stringifyYaml(doc, { indent: 2, lineWidth: 0 }), "utf8");
  return { added: true };
}

/**
 * Per-repo ingestion mode override. Mirrors Slice C's adapter-side
 * `repoModes: Record<owner/name, "dossier" | "full" | "both">` config —
 * a row missing from the map falls back to the adapter-level `mode`,
 * which falls back to `dossier` if unset. The dashboard's row-level
 * Mode dropdown writes here.
 */
export type GithubRepoMode = "dossier" | "full" | "both";

export interface GithubModeSnapshot {
  /** Adapter-default mode. `null` when the adapter entry is missing. */
  adapterMode: GithubRepoMode | null;
  /** Per-repo overrides; entries WITHOUT an override are omitted. */
  repoModes: Record<string, GithubRepoMode>;
}

const VALID_MODES: ReadonlySet<GithubRepoMode> = new Set([
  "dossier",
  "full",
  "both",
]);

export function isGithubRepoMode(value: unknown): value is GithubRepoMode {
  return typeof value === "string" && VALID_MODES.has(value as GithubRepoMode);
}

/**
 * Snapshot the adapter-level mode + the per-repo override map. Both
 * fields ride under `adapters.github.config`; reads from the .local
 * overlay first so the dashboard sees what the writer most recently
 * wrote.
 */
export async function readGithubModeSnapshot(
  configPath: string,
): Promise<GithubModeSnapshot> {
  const effectivePath = await pickLocalOrBase(configPath);
  let raw: string;
  try {
    raw = await readFile(effectivePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { adapterMode: null, repoModes: {} };
    }
    throw err;
  }
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const adapters = parsed.adapters as Record<string, unknown> | undefined;
  const github = adapters?.github as Record<string, unknown> | undefined;
  const cfg = github?.config as Record<string, unknown> | undefined;
  const adapterMode =
    cfg && isGithubRepoMode(cfg.mode) ? (cfg.mode as GithubRepoMode) : null;
  const rawRepoModes = cfg?.repoModes;
  const repoModes: Record<string, GithubRepoMode> = {};
  if (rawRepoModes && typeof rawRepoModes === "object") {
    for (const [slug, value] of Object.entries(
      rawRepoModes as Record<string, unknown>,
    )) {
      if (typeof slug !== "string" || slug.length === 0) continue;
      if (isGithubRepoMode(value)) repoModes[slug] = value;
    }
  }
  return { adapterMode, repoModes };
}

/**
 * Set or clear a per-repo mode override. `mode: null` removes the
 * override, so the repo falls back to the adapter-level default.
 * Idempotent — returns `{changed: false}` when the desired value
 * already matches what's on disk.
 *
 * Caller is responsible for triggering a config reload after a
 * successful change.
 */
export async function setGithubRepoMode(
  configPath: string,
  fullName: string,
  mode: GithubRepoMode | null,
): Promise<{ changed: boolean }> {
  if (mode !== null && !isGithubRepoMode(mode)) {
    throw new Error(`invalid github repo mode: ${String(mode)}`);
  }
  const targetPath = await ensureLocalCopy(configPath);
  let raw: string;
  try {
    raw = await readFile(targetPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = "";
    else throw err;
  }
  const doc = (raw.trim().length > 0 ? (parseYaml(raw) ?? {}) : {}) as Record<
    string,
    unknown
  >;
  const adapters = ((doc.adapters as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  // Auto-create the github adapter entry on first-mode-set just like
  // `appendGithubRepo` does — the dashboard treats both writes as
  // self-bootstrapping so users don't have to "enable github" first.
  const github = ((adapters.github as Record<string, unknown>) ?? {
    package: "@onenomad/przm-cortex-adapter-github",
    enabled: true,
    config: {},
  }) as Record<string, unknown>;
  if (typeof github.package !== "string") {
    github.package = "@onenomad/przm-cortex-adapter-github";
  }
  if (typeof github.enabled !== "boolean") github.enabled = true;
  const cfg = ((github.config as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  const existingRaw = cfg.repoModes;
  const existing: Record<string, string> =
    existingRaw && typeof existingRaw === "object"
      ? Object.fromEntries(
          Object.entries(existingRaw as Record<string, unknown>).filter(
            ([k, v]) => typeof k === "string" && isGithubRepoMode(v),
          ) as Array<[string, string]>,
        )
      : {};

  if (mode === null) {
    if (!(fullName in existing)) return { changed: false };
    delete existing[fullName];
  } else {
    if (existing[fullName] === mode) return { changed: false };
    existing[fullName] = mode;
  }

  if (Object.keys(existing).length > 0) {
    cfg.repoModes = existing;
  } else {
    delete cfg.repoModes;
  }
  github.config = cfg;
  adapters.github = github;
  doc.adapters = adapters;
  await writeFile(
    targetPath,
    stringifyYaml(doc, { indent: 2, lineWidth: 0 }),
    "utf8",
  );
  return { changed: true };
}

/**
 * Resolve the effective mode for one repo given a snapshot. The default
 * when nothing's configured anywhere is `dossier`, matching Slice A's
 * recommended posture — knowledge-first ingest, full source only when
 * the user explicitly opts in.
 */
export function resolveGithubRepoMode(
  snapshot: GithubModeSnapshot,
  fullName: string,
): GithubRepoMode {
  return (
    snapshot.repoModes[fullName] ??
    snapshot.adapterMode ??
    "dossier"
  );
}

/**
 * Drop `<owner>/<name>` from the github.repos list. Returns whether a
 * row was removed so the caller can render an accurate "Removed N
 * repos" line and skip the reload when nothing changed.
 */
export async function removeGithubRepo(
  configPath: string,
  fullName: string,
): Promise<{ removed: boolean }> {
  const effectivePath = await pickLocalOrBase(configPath);
  let raw: string;
  try {
    raw = await readFile(effectivePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed: false };
    throw err;
  }
  const doc = (raw.trim().length > 0 ? (parseYaml(raw) ?? {}) : {}) as Record<
    string,
    unknown
  >;
  const adapters = doc.adapters as Record<string, unknown> | undefined;
  const github = adapters?.github as Record<string, unknown> | undefined;
  const cfg = github?.config as Record<string, unknown> | undefined;
  const repos = Array.isArray(cfg?.repos)
    ? ((cfg!.repos as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      ) as string[])
    : [];
  if (!repos.includes(fullName)) {
    return { removed: false };
  }
  const next = repos.filter((r) => r !== fullName);
  // Cast non-null because we read repos via cfg, so cfg is defined.
  (cfg as Record<string, unknown>).repos = next;
  // Persist back.
  await writeFile(effectivePath, stringifyYaml(doc, { indent: 2, lineWidth: 0 }), "utf8");
  return { removed: true };
}

/**
 * Resolve the .local overlay if it exists, otherwise the committed
 * template path. Mirrors `resolveLocalFirst` but synchronous-friendly
 * by virtue of being awaitable — we keep this helper local so the
 * github-config module doesn't have to import from config.ts (which
 * pulls a Zod schema chain that's heavy for the MCP tool path).
 */
async function pickLocalOrBase(configPath: string): Promise<string> {
  const ext = configPath.endsWith(".yaml")
    ? ".yaml"
    : configPath.endsWith(".yml")
      ? ".yml"
      : "";
  if (!ext) return configPath;
  const base = configPath.slice(0, -ext.length);
  const localPath = `${base}.local${ext}`;
  try {
    await readFile(localPath, "utf8");
    return localPath;
  } catch {
    return configPath;
  }
}
