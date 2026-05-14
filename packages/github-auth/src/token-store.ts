import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

/**
 * Persisted GitHub token shape. Lives under ~/.cortex/ as JSON.
 * (The sibling cortex-google-auth package was removed in Phase 1A
 * of the knowledge-engine repositioning, 2026-05-09.)
 */
export const githubTokenSchema = z.object({
  accessToken: z.string().min(1),
  /** OAuth scopes the token was granted. Adapters can introspect. */
  scopes: z.array(z.string()).default([]),
  /** OAuth app id the token belongs to. Surfaced for debugging. */
  clientId: z.string().min(1),
  /** ISO 8601 timestamp when the device flow completed. */
  grantedAt: z.string(),
});

export type GithubToken = z.infer<typeof githubTokenSchema>;

/**
 * Location of the persisted token file. Overridable via
 * CORTEX_GITHUB_TOKEN_PATH for containerized or multi-account setups.
 */
export function defaultTokenPath(): string {
  const override = process.env.CORTEX_GITHUB_TOKEN_PATH;
  if (override) return override;
  return path.join(os.homedir(), ".cortex", "github-token.json");
}

export async function readGithubToken(
  tokenPath: string = defaultTokenPath(),
): Promise<GithubToken> {
  let raw: string;
  try {
    raw = await readFile(tokenPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `GitHub token file not found at ${tokenPath}. Run \`cortex github-login\` to authorize.`,
      );
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  return githubTokenSchema.parse(parsed);
}

export async function writeGithubToken(
  token: GithubToken,
  tokenPath: string = defaultTokenPath(),
): Promise<void> {
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(token, null, 2), "utf8");
}

/**
 * Try to read the token, return undefined if the file is missing or
 * malformed. Used by adapters that want to prefer the token file but
 * gracefully fall back to `GITHUB_TOKEN` env.
 */
export async function tryReadGithubToken(
  tokenPath: string = defaultTokenPath(),
): Promise<GithubToken | undefined> {
  try {
    return await readGithubToken(tokenPath);
  } catch {
    return undefined;
  }
}
