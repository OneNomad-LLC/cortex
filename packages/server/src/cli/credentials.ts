import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Cloud-mode credentials + current CLI mode. Lives at
 * `~/.config/cortex/credentials.json` (or `$XDG_CONFIG_HOME/cortex/...`)
 * with file perms 0600. Written by `cortex login`; read by `cortex
 * serve` to decide whether to spin up a local server or stdio-proxy to
 * a remote one.
 *
 * Env var overrides:
 *   CORTEX_MCP_URL    — remote MCP endpoint. Skips the file.
 *   CORTEX_MCP_TOKEN  — bearer token. Skips the file.
 *
 * When *both* env vars are present, mode is implicitly cloud and the
 * credentials file isn't read. The env-var path is what CI/CD systems,
 * Vault, AWS Secrets Manager, 1Password CLI use to inject credentials
 * without ever touching disk.
 */

export type CortexMode = "local" | "cloud";

export interface CortexCredentials {
  mode: CortexMode;
  /** Remote MCP endpoint, e.g. `https://cortex-acme.fly.dev:3100/mcp`. Cloud mode only. */
  mcpUrl?: string;
  /** Bearer token (plaintext). Cloud mode only. */
  bearer?: string;
  /** Tenant slug — surfaced by `whoami`, never used for auth. */
  tenantSlug?: string;
  /** Human label for the logged-in user. */
  userEmail?: string;
  /** pyre-web server the user logged in against (e.g. `https://getpyre.ai`). */
  loginServer?: string;
  /** ISO timestamp of last refresh. */
  updatedAt?: string;
}

export interface ResolvedCredentials extends CortexCredentials {
  /** True when env-var overrides supplied the values (file not read). */
  fromEnv: boolean;
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return path.join(xdg, "cortex");
  return path.join(os.homedir(), ".config", "cortex");
}

function credentialsPath(): string {
  return path.join(configDir(), "credentials.json");
}

/**
 * Load credentials. Env vars trump the file. Returns a sane default
 * (mode=local) when neither is set, so callers can rely on a stable
 * shape.
 */
export async function loadCredentials(): Promise<ResolvedCredentials> {
  const envUrl = process.env.CORTEX_MCP_URL;
  const envToken = process.env.CORTEX_MCP_TOKEN;
  if (envUrl && envToken) {
    return {
      mode: "cloud",
      mcpUrl: envUrl,
      bearer: envToken,
      fromEnv: true,
    };
  }

  const filePath = credentialsPath();
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CortexCredentials>;
    const mode: CortexMode = parsed.mode === "cloud" ? "cloud" : "local";
    return {
      mode,
      fromEnv: false,
      ...(parsed.mcpUrl ? { mcpUrl: parsed.mcpUrl } : {}),
      ...(parsed.bearer ? { bearer: parsed.bearer } : {}),
      ...(parsed.tenantSlug ? { tenantSlug: parsed.tenantSlug } : {}),
      ...(parsed.userEmail ? { userEmail: parsed.userEmail } : {}),
      ...(parsed.loginServer ? { loginServer: parsed.loginServer } : {}),
      ...(parsed.updatedAt ? { updatedAt: parsed.updatedAt } : {}),
    };
  } catch {
    return { mode: "local", fromEnv: false };
  }
}

/**
 * Write credentials atomically with 0600 perms. The parent directory
 * is created 0700 if it doesn't exist. We never log the bearer.
 */
export async function saveCredentials(creds: CortexCredentials): Promise<string> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = credentialsPath();
  const tmpPath = `${filePath}.tmp`;
  const payload: CortexCredentials = {
    ...creds,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(tmpPath, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  // Rename for atomicity. On the same filesystem this is a single
  // syscall and either fully succeeds or leaves the prior file intact.
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, filePath);
  return filePath;
}

/**
 * Delete the credentials file. Returns true when a file was removed,
 * false when there was nothing to delete. Used by `cortex logout`.
 */
export async function clearCredentials(): Promise<boolean> {
  const filePath = credentialsPath();
  try {
    await stat(filePath);
  } catch {
    return false;
  }
  const { unlink } = await import("node:fs/promises");
  await unlink(filePath);
  return true;
}

/** Where the credentials live — surfaced by `whoami` for debuggability. */
export function getCredentialsPath(): string {
  return credentialsPath();
}
