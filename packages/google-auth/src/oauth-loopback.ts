import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { GoogleApiError } from "./errors.js";
import { writeGoogleToken, type GoogleToken } from "./token-store.js";

/**
 * Installed-app OAuth flow. Spins up a temporary HTTP server on localhost,
 * prints the Google consent URL, waits for the redirect, exchanges the
 * authorization code for a refresh token, and writes the result to the
 * token store.
 *
 * Works from any CLI environment that can bind a localhost port and reach
 * oauth2.googleapis.com. No separate browser-automation dependency.
 */

export interface OAuthLoopbackOptions {
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  /** Host to bind. Defaults to 127.0.0.1. */
  host?: string;
  /** Port to bind. 0 = OS-picked ephemeral port. Defaults to 0. */
  port?: number;
  /** Where to store the token file. Uses defaultTokenPath() if omitted. */
  tokenPath?: string;
  /** Called with the consent URL so the caller can print/open it. */
  onAuthUrl: (url: string) => void;
  /** Overall timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Run the full flow end-to-end. Returns the stored token.
 */
export async function runOAuthLoopback(opts: OAuthLoopbackOptions): Promise<GoogleToken> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 1. Bind the loopback server first so we know the redirect URI before
  //    we build the auth URL.
  const { server, redirectUri, codePromise } = await startLoopbackServer(host, port);
  try {
    // 2. Build and emit the consent URL.
    const authUrl = buildAuthUrl({
      clientId: opts.clientId,
      scopes: opts.scopes,
      redirectUri,
    });
    opts.onAuthUrl(authUrl);

    // 3. Race the redirect against the timeout.
    const code = await Promise.race([
      codePromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new GoogleApiError(`OAuth loopback timed out after ${timeoutMs}ms`, 408, "")),
          timeoutMs,
        ),
      ),
    ]);

    // 4. Exchange the code for a refresh token.
    const token = await exchangeCodeForToken({
      code,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      redirectUri,
      scopes: opts.scopes,
      fetchImpl,
    });

    // 5. Persist.
    await writeGoogleToken(token, opts.tokenPath);
    return token;
  } finally {
    server.close();
  }
}

interface LoopbackHandle {
  server: ReturnType<typeof createServer>;
  redirectUri: string;
  codePromise: Promise<string>;
}

async function startLoopbackServer(host: string, port: number): Promise<LoopbackHandle> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== "/cb") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain");
      res.end(`OAuth error: ${error}. You can close this tab.`);
      rejectCode(new GoogleApiError(`OAuth consent error: ${error}`, 400, ""));
      return;
    }
    if (!code) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain");
      res.end("Missing ?code= in redirect. You can close this tab.");
      rejectCode(new GoogleApiError("OAuth redirect missing code parameter", 400, ""));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      "<!doctype html><title>Cortex</title><h1>Cortex is authenticated.</h1>" +
        "<p>You can close this tab.</p>",
    );
    resolveCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const redirectUri = `http://${host}:${addr.port}/cb`;
  return { server, redirectUri, codePromise };
}

function buildAuthUrl(opts: {
  clientId: string;
  scopes: readonly string[];
  redirectUri: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scopes.join(" "));
  // Offline access is what makes Google return a refresh_token; prompt=consent
  // forces it to re-issue a refresh_token even if the user has approved before.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

interface ExchangeOpts {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: readonly string[];
  fetchImpl: typeof fetch;
}

async function exchangeCodeForToken(opts: ExchangeOpts): Promise<GoogleToken> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await opts.fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GoogleApiError(
      `Google token exchange failed: ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
      res.status,
      text,
    );
  }
  const json = (await res.json()) as {
    refresh_token?: string;
    scope?: string;
  };
  if (!json.refresh_token) {
    throw new GoogleApiError(
      "Google token exchange succeeded but returned no refresh_token. " +
        "Re-run with prompt=consent and make sure offline access is requested.",
      400,
      JSON.stringify(json),
    );
  }
  return {
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: json.refresh_token,
    scopes: json.scope ? json.scope.split(/\s+/).filter(Boolean) : [...opts.scopes],
    token_endpoint: "https://oauth2.googleapis.com/token",
  };
}
