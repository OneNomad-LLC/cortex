/**
 * GitHub device-flow endpoints for the dashboard "Connect GitHub" button.
 * The dashboard polls `/complete` every ~3s from the moment the user
 * sees the short code until GitHub reports approved / denied / expired.
 * That keeps the polling logic in the browser where we can show
 * progress instead of tying up a server request.
 *
 * - GET  /api/auth/github/status      — is a token stored?
 * - POST /api/auth/github/start       — kick off device flow; returns user code
 * - POST /api/auth/github/complete    — finalize (poll GitHub once, store token on success)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { readJsonBody, sendJson } from "../http.js";
import {
  createDeviceFlow,
  defaultTokenPath as defaultGithubTokenPath,
  tryReadGithubToken,
  writeGithubToken,
  type DeviceCodeGrant,
} from "@onenomad/cortex-github-auth";

const pendingGithubGrants = new Map<string, DeviceCodeGrant>();
const GITHUB_CLIENT_ID =
  process.env.CORTEX_GITHUB_CLIENT_ID ?? "Ov23lidpaSywVEHtcXa4";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/auth/github/")) return false;

  const { pathname } = ctx;

  try {
    if (req.method === "GET" && pathname === "/api/auth/github/status") {
      const token = await tryReadGithubToken();
      if (!token) {
        sendJson(res, 200, { authenticated: false });
        return true;
      }
      sendJson(res, 200, {
        authenticated: true,
        scopes: token.scopes,
        grantedAt: token.grantedAt,
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/auth/github/start") {
      const body = (await readJsonBody(req)) as { scopes?: string[] };
      const scopes = body.scopes ?? ["repo"];
      const flow = createDeviceFlow({ clientId: GITHUB_CLIENT_ID, scopes });
      const grant = await flow.start();
      pendingGithubGrants.set(grant.deviceCode, grant);
      // Reap expired grants so the map doesn't grow forever if the user
      // abandons the flow.
      for (const [code, g] of pendingGithubGrants) {
        if (g.expiresAt.getTime() < Date.now()) {
          pendingGithubGrants.delete(code);
        }
      }
      sendJson(res, 200, {
        deviceCode: grant.deviceCode,
        userCode: grant.userCode,
        verificationUri: grant.verificationUri,
        expiresAt: grant.expiresAt.toISOString(),
        pollIntervalSeconds: grant.pollIntervalSeconds,
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/auth/github/complete") {
      const body = (await readJsonBody(req)) as { deviceCode?: string };
      if (!body.deviceCode) {
        sendJson(res, 400, { error: "deviceCode required" });
        return true;
      }
      const grant = pendingGithubGrants.get(body.deviceCode);
      if (!grant) {
        sendJson(res, 410, {
          status: "expired",
          error:
            "device code not found — it may have expired or already been consumed",
        });
        return true;
      }
      // One-shot poll: a single token request, treating
      // authorization_pending as a "keep polling" hint to the caller
      // rather than blocking server-side.
      const resp = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            device_code: grant.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }).toString(),
        },
      );
      const json = (await resp.json().catch(() => ({}))) as {
        access_token?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (json.access_token) {
        pendingGithubGrants.delete(body.deviceCode);
        const scopes = (json.scope ?? "").split(/[\s,]+/).filter(Boolean);
        await writeGithubToken(
          {
            accessToken: json.access_token,
            scopes,
            clientId: GITHUB_CLIENT_ID,
            grantedAt: new Date().toISOString(),
          },
          defaultGithubTokenPath(),
        );
        sendJson(res, 200, { status: "authorized", scopes });
        return true;
      }
      if (json.error === "authorization_pending" || json.error === "slow_down") {
        sendJson(res, 200, {
          status: "pending",
          hint:
            json.error === "slow_down"
              ? "GitHub asked us to slow down polling — wait a bit longer between tries."
              : undefined,
        });
        return true;
      }
      if (json.error === "expired_token" || json.error === "access_denied") {
        pendingGithubGrants.delete(body.deviceCode);
        sendJson(res, 200, {
          status: json.error === "expired_token" ? "expired" : "denied",
        });
        return true;
      }
      sendJson(res, 500, {
        status: "error",
        error: json.error ?? "unknown response from GitHub",
        detail: json.error_description ?? null,
      });
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    ctx.logger.warn("api.github_auth.failed", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
