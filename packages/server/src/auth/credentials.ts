/**
 * Shared credentials file at ~/.pyre/credentials.json — read/write/delete
 * with cortex-specific extension. Mirrors engram's auth/credentials.ts so
 * that one login per machine logs the user into engram, persona, AND
 * cortex.
 *
 * File shape (additive across products):
 *   {
 *     "api_url":   "https://pyre.sh",          // engram/persona base
 *     "api_key":   "sk_pyre_...",
 *     "label":     "matt-laptop",
 *     "scopes":    ["engram", "persona", "cortex"],
 *     "issued_at": "2026-05-14T...",
 *     "cortex": {                              // cortex-specific section
 *       "active_tenant": "acme",
 *       "tenants": [
 *         { "slug": "acme", "mcp_url": "https://acme.cortex.pyre.sh", "bearer": "sk_pyre_..." }
 *       ]
 *     }
 *   }
 *
 * Cortex code MUST treat non-cortex fields as opaque pass-through. When
 * we write back, we preserve everything we don't touch — losing engram's
 * api_key on a cortex login would silently log the user out of memory.
 *
 * Env var overrides:
 *   CORTEX_MCP_URL    — direct MCP endpoint (CI/secrets manager).
 *   CORTEX_MCP_TOKEN  — bearer token (same).
 *
 * When both are present, mode is implicitly cloud and the file isn't
 * read for cortex. The shared file is still read for engram/persona.
 *
 * Path overrides:
 *   PYRE_CREDENTIALS_FILE — explicit absolute path. Same env var engram
 *   uses; staying symmetric so per-test or per-deploy isolation works the
 *   same across products.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ── Public types ────────────────────────────────────────────────────

export interface CortexTenant {
  slug: string;
  mcp_url: string;
  bearer: string;
}

export interface CortexCredentialsSection {
  /** Slug of the tenant cortex CLI talks to. Undefined when tenants is empty. */
  active_tenant?: string;
  /** All tenants the user belongs to. Empty array = solo Pro user with no cortex access. */
  tenants?: CortexTenant[];
  /** Mode flag — `cortex use local|cloud` writes this. Default cloud when tenants present. */
  mode?: CortexMode;
}

export interface SharedCredentialsFile {
  // Engram/persona fields — opaque to cortex; preserved on write.
  api_url?: string;
  api_key?: string;
  label?: string;
  scopes?: string[];
  issued_at?: string;
  // Cortex-specific extension.
  cortex?: CortexCredentialsSection;
  // Tolerate unknown fields from future products without dropping them.
  [key: string]: unknown;
}

export type CortexMode = "local" | "cloud";

/** Flat view of cortex credentials for runtime consumers (whoami, serve, use). */
export interface ResolvedCortexCredentials {
  mode: CortexMode;
  /** Active tenant's MCP endpoint. Cloud mode only. */
  mcp_url?: string;
  /** Active tenant's bearer. Cloud mode only. */
  bearer?: string;
  /** Active tenant slug. */
  tenant_slug?: string;
  /** Login identity (engram/persona's `label` field — typically email). */
  user_email?: string;
  /** pyre-web URL the user logged in against (engram/persona's `api_url`). */
  login_server?: string;
  /** True when env vars supplied the values; the file may exist but isn't authoritative for cortex. */
  fromEnv: boolean;
  /** Count of tenants the user belongs to — surfaced by whoami / login. */
  tenant_count: number;
}

// ── Path resolution ─────────────────────────────────────────────────

/**
 * Resolve the credentials file path. Symmetric with engram:
 *   1. explicit `path` arg
 *   2. PYRE_CREDENTIALS_FILE env var
 *   3. ~/.pyre/credentials.json
 */
export function credentialsPath(path?: string): string {
  if (path) return path;
  const fromEnv = process.env.PYRE_CREDENTIALS_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return join(homedir(), ".pyre", "credentials.json");
}

/** Where the credentials live — surfaced by whoami for debuggability. */
export function getCredentialsPath(): string {
  return credentialsPath();
}

/** Legacy ~/.config/cortex/credentials.json — only used by the one-time migration. */
function legacyCortexCredentialsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = xdg && xdg.length > 0 ? join(xdg, "cortex") : join(homedir(), ".config", "cortex");
  return join(dir, "credentials.json");
}

// ── File-level read/write (whole-file, preserves unknown fields) ────

function warn(msg: string): void {
  process.stderr.write(`cortex: credentials — ${msg}\n`);
}

/**
 * Read the shared file. Returns null when missing or unparseable. Never
 * throws — callers must keep working in local mode if creds are broken.
 */
export function readSharedCredentials(path?: string): SharedCredentialsFile | null {
  const file = credentialsPath(path);
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    warn(`could not read ${file}: ${(err as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`malformed JSON in ${file}: ${(err as Error).message}`);
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(`credentials file is not a JSON object — ignoring`);
    return null;
  }
  return parsed as SharedCredentialsFile;
}

/**
 * Atomically write the shared file with mode 0600. Creates the parent
 * directory at 0700 if needed.
 */
export function writeSharedCredentials(creds: SharedCredentialsFile, path?: string): void {
  const file = credentialsPath(path);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  // chmod the parent best-effort; some filesystems (FAT, mounted shares)
  // don't support POSIX modes.
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }

  const body = JSON.stringify(creds, null, 2) + "\n";
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, encoding: "utf-8" });
  // writeFileSync's `mode` only applies to a freshly created file —
  // belt-and-suspenders for the case where tmp already existed.
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

// ── Cortex section helpers ──────────────────────────────────────────

/**
 * Resolve the cortex view: env-var overrides first, then file. Returns a
 * stable shape (mode=local, fromEnv=false, tenant_count=0) when nothing
 * is configured so callers can rely on the fields being present.
 */
export function loadCortexCredentials(path?: string): ResolvedCortexCredentials {
  // Side-effect: opportunistic legacy migration. Cheap when there's
  // nothing to migrate; runs at most once per machine in practice.
  migrateLegacyCredentialsOnce();

  const envUrl = process.env.CORTEX_MCP_URL;
  const envToken = process.env.CORTEX_MCP_TOKEN;
  if (envUrl && envToken) {
    return {
      mode: "cloud",
      mcp_url: envUrl,
      bearer: envToken,
      fromEnv: true,
      tenant_count: 0,
    };
  }

  const file = readSharedCredentials(path);
  const cortex = file?.cortex;
  const tenants = cortex?.tenants ?? [];
  const activeSlug = cortex?.active_tenant ?? tenants[0]?.slug;
  const active = tenants.find((t) => t.slug === activeSlug);
  // Mode default: cloud when we have an active tenant, local otherwise.
  // Honor an explicit `mode` flag when present (set by `cortex use ...`).
  const mode: CortexMode = cortex?.mode ?? (active ? "cloud" : "local");

  return {
    mode,
    fromEnv: false,
    tenant_count: tenants.length,
    ...(active?.mcp_url ? { mcp_url: active.mcp_url } : {}),
    ...(active?.bearer ? { bearer: active.bearer } : {}),
    ...(active?.slug ? { tenant_slug: active.slug } : {}),
    ...(file?.label ? { user_email: file.label } : {}),
    ...(file?.api_url ? { login_server: file.api_url } : {}),
  };
}

/**
 * Update only the cortex section of the shared file. Engram/persona
 * fields are preserved untouched. Pass `tenants: []` to clear all
 * tenants without removing the section.
 */
export function saveCortexCredentials(
  updates: Partial<CortexCredentialsSection>,
  path?: string,
): void {
  const file = readSharedCredentials(path) ?? {};
  const existing = file.cortex ?? {};
  const next: CortexCredentialsSection = {
    ...existing,
    ...updates,
  };
  // If active_tenant points at a slug that's not in the new tenants
  // list, fall back to the first tenant (or undefined when empty).
  if (next.tenants && next.active_tenant) {
    const exists = next.tenants.some((t) => t.slug === next.active_tenant);
    if (!exists) {
      const fallback = next.tenants[0]?.slug;
      if (fallback) {
        next.active_tenant = fallback;
      } else {
        delete next.active_tenant;
      }
    }
  }
  file.cortex = next;
  writeSharedCredentials(file, path);
}

/**
 * Drop the cortex section entirely. Engram/persona credentials in the
 * same file are preserved — this is `cortex logout`, not "wipe pyre."
 *
 * If the file becomes effectively empty (no engram fields and no cortex
 * section), delete it. Returns true when something was removed.
 *
 * Known gotcha: engram's `engram-mcp logout` currently deletes the
 * whole file, which would also nuke the cortex section. That's a
 * cross-repo cleanup tracked separately.
 */
export function clearCortexCredentials(path?: string): boolean {
  const file = readSharedCredentials(path);
  if (!file) return false;
  if (!file.cortex) return false;

  delete file.cortex;
  // Did we leave an empty husk behind?
  const remaining = Object.keys(file).filter((k) => file[k] !== undefined);
  if (remaining.length === 0) {
    const target = credentialsPath(path);
    try {
      unlinkSync(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    return true;
  }
  writeSharedCredentials(file, path);
  return true;
}

/** Existence check used by whoami. Doesn't validate. */
export function credentialsExist(path?: string): boolean {
  return existsSync(credentialsPath(path));
}

/** Stat the file. Exported for tests asserting file mode after write. */
export function credentialsStat(path?: string) {
  return statSync(credentialsPath(path));
}

// ── One-time legacy migration ───────────────────────────────────────

interface LegacyCortexCredentials {
  mode?: string;
  mcpUrl?: string;
  bearer?: string;
  tenantSlug?: string;
  userEmail?: string;
  loginServer?: string;
  updatedAt?: string;
}

/**
 * One-time migration: ~/.config/cortex/credentials.json → ~/.pyre/credentials.json.
 *
 * Reads the legacy file (if present), folds it into the shared shape's
 * cortex section as a single tenant, then deletes the legacy file. No-op
 * when the legacy file is missing. Errors are warned but never thrown —
 * a broken legacy file shouldn't block fresh logins.
 *
 * Idempotent: once the legacy file is gone, subsequent calls are a single
 * `existsSync` check.
 */
export function migrateLegacyCredentials(): boolean {
  const legacyPath = legacyCortexCredentialsPath();
  if (!existsSync(legacyPath)) return false;

  let raw: string;
  try {
    raw = readFileSync(legacyPath, "utf-8");
  } catch (err) {
    warn(`legacy migration: could not read ${legacyPath}: ${(err as Error).message}`);
    return false;
  }
  let parsed: LegacyCortexCredentials;
  try {
    parsed = JSON.parse(raw) as LegacyCortexCredentials;
  } catch (err) {
    warn(`legacy migration: malformed JSON in ${legacyPath}: ${(err as Error).message}`);
    // Don't delete — let the user inspect what went wrong.
    return false;
  }

  // Only migrate if there's a real cloud credential to carry over.
  // Local-mode legacy files have nothing of value to merge.
  if (parsed.mcpUrl && parsed.bearer) {
    const slug = parsed.tenantSlug && parsed.tenantSlug.length > 0 ? parsed.tenantSlug : "default";
    const file = readSharedCredentials() ?? {};
    const existing = file.cortex ?? {};
    const tenants = existing.tenants ?? [];
    // Don't duplicate if the user already has this tenant in the new file.
    const alreadyHave = tenants.some((t) => t.slug === slug);
    if (!alreadyHave) {
      tenants.push({ slug, mcp_url: parsed.mcpUrl, bearer: parsed.bearer });
    }
    file.cortex = {
      ...existing,
      tenants,
      ...(existing.active_tenant ? {} : { active_tenant: slug }),
    };
    // Preserve engram/persona base fields if the legacy file happened to
    // carry an email. (It did, as `userEmail`.) Don't overwrite if engram
    // already wrote a label.
    if (!file.label && parsed.userEmail) {
      file.label = parsed.userEmail;
    }
    if (!file.api_url && parsed.loginServer) {
      file.api_url = parsed.loginServer;
    }
    try {
      writeSharedCredentials(file);
    } catch (err) {
      warn(`legacy migration: could not write merged file: ${(err as Error).message}`);
      return false;
    }
  }

  // Whether or not we carried anything over, retire the legacy file so
  // the migration runs at most once.
  try {
    unlinkSync(legacyPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warn(`legacy migration: could not delete ${legacyPath}: ${(err as Error).message}`);
    }
  }
  return true;
}

let migrationAttempted = false;
function migrateLegacyCredentialsOnce(): void {
  if (migrationAttempted) return;
  migrationAttempted = true;
  try {
    migrateLegacyCredentials();
  } catch (err) {
    // Defensive — migrateLegacyCredentials shouldn't throw, but make sure
    // a buggy migration can never block the runtime.
    warn(`legacy migration crashed (continuing): ${(err as Error).message}`);
  }
}

/** Test-only — reset the once-guard so tests can re-run migration. */
export function _resetMigrationGuardForTests(): void {
  migrationAttempted = false;
}
