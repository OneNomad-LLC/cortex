/**
 * `/api/dashboard/settings/allowlist` — read/mutate the GitHub OAuth
 * allowlist (`PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST` in the workspace
 * `.env`). Powers the dashboard's Settings → Access page so the
 * operator can add/remove signed-in users without SSHing the box.
 *
 * Surface:
 *   GET    /api/dashboard/settings/allowlist                  → { entries: string[] }
 *   POST   /api/dashboard/settings/allowlist                  → { entries: string[] }
 *     body: { login: string }   (case-insensitive; deduped against existing entries)
 *   DELETE /api/dashboard/settings/allowlist/:login           → { entries: string[] }
 *
 * Auth: every method requires admin scope (the allowlist gates who
 * else can sign in — only admins should be touching it).
 * CSRF: POST/DELETE require `X-Cortex-Dashboard: 1` via the middleware.
 *
 * Persistence: mergeEnv writes atomically (tmp-then-rename) so a
 * concurrent dashboard request can't see a half-written `.env`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readJsonBody } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";
import { mergeEnv } from "../../cli/config-mutation.js";
import { parseDotEnv } from "../../cli/dotenv.js";
import { parseAllowlist } from "../../auth/github-oauth.js";

const PREFIX = "/api/dashboard/settings/allowlist";
const ENV_KEY = "PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST";
// GitHub usernames: alphanumeric + hyphens, ≤39 chars, no consecutive
// hyphens, can't start or end with a hyphen.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const gate = requireDashboardAuth(["admin"]);

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith(PREFIX)) return false;

  const session = await gate(req, res);
  if (!session) return true; // middleware sent the 401/403

  const ws = await getActiveWorkspace();
  if (!ws) {
    sendJson(res, 400, {
      error: "no_workspace_bound",
      message: "this session has no workspace — cortex workspace switch <slug>",
    });
    return true;
  }

  const remainder = ctx.pathname.slice(PREFIX.length);

  // GET /
  if (req.method === "GET" && (remainder === "" || remainder === "/")) {
    const entries = await readEntries(ws.envPath);
    sendJson(res, 200, { entries });
    return true;
  }

  // POST /
  if (req.method === "POST" && (remainder === "" || remainder === "/")) {
    const body = (await readJsonBody(req).catch(() => undefined)) as
      | { login?: unknown }
      | undefined;
    const login = String(body?.login ?? "").trim();
    if (!login) {
      sendJson(res, 400, { error: "login_required" });
      return true;
    }
    if (!GITHUB_LOGIN_RE.test(login)) {
      sendJson(res, 400, {
        error: "invalid_login",
        message:
          "doesn't look like a github username (a-z, 0-9, hyphens; ≤39 chars)",
      });
      return true;
    }
    const existing = await readEntries(ws.envPath);
    const next = upsert(existing, login);
    await writeEntries(ws.envPath, next);
    sendJson(res, 200, { entries: next });
    return true;
  }

  // DELETE /:login
  if (req.method === "DELETE" && remainder.startsWith("/")) {
    const raw = decodeURIComponent(remainder.slice(1));
    if (!raw) {
      sendJson(res, 400, { error: "login_required" });
      return true;
    }
    const existing = await readEntries(ws.envPath);
    const lowered = raw.toLowerCase();
    const next = existing.filter((e) => e.toLowerCase() !== lowered);
    if (next.length === existing.length) {
      sendJson(res, 404, { error: "not_found", login: raw });
      return true;
    }
    await writeEntries(ws.envPath, next);
    sendJson(res, 200, { entries: next });
    return true;
  }

  // Unknown method on a path we own → 405.
  res.writeHead(405, { allow: "GET, POST, DELETE" });
  res.end();
  return true;
}

async function readEntries(envPath: string): Promise<string[]> {
  const env = await parseDotEnv(envPath);
  const raw = env.get(ENV_KEY);
  // parseAllowlist normalizes to lowercase set — but we want the user's
  // original casing for the UI. Read the raw value, split, trim. Dedup
  // case-insensitively so we don't surface "Matt" + "matt" as two rows.
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

async function writeEntries(envPath: string, entries: string[]): Promise<void> {
  await mergeEnv(envPath, { [ENV_KEY]: entries.join(",") });
}

function upsert(existing: string[], login: string): string[] {
  const lowered = login.toLowerCase();
  if (existing.some((e) => e.toLowerCase() === lowered)) return existing;
  return [...existing, login];
}
