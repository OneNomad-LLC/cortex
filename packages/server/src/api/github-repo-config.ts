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
