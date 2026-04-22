import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOAuthLoopback } from "../src/oauth-loopback.js";

const tmps: string[] = [];

afterEach(async () => {
  for (const t of tmps.splice(0)) {
    await rm(t, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function mkTokenPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cortex-gauth-"));
  tmps.push(dir);
  return path.join(dir, "google-token.json");
}

describe("runOAuthLoopback", () => {
  it("drives the full flow: consent URL → code → token exchange → token file", async () => {
    const tokenPath = await mkTokenPath();
    let capturedUrl: string | undefined;
    // The mock fetch returns a refresh_token when the loopback hands it a code.
    const calls: Array<{ url: string; body: string }> = [];
    const mockFetch: typeof fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, body });
      return new Response(
        JSON.stringify({
          refresh_token: "rt-xyz",
          scope: "https://www.googleapis.com/auth/gmail.readonly",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    // Kick off the flow; as soon as we get the auth URL, fire a request at the
    // loopback's /cb with a fake ?code= to unblock the exchange.
    const promise = runOAuthLoopback({
      clientId: "client-123",
      clientSecret: "secret-abc",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      tokenPath,
      onAuthUrl: (url) => {
        capturedUrl = url;
        const redirect = new URL(url).searchParams.get("redirect_uri")!;
        // Fire the simulated browser callback (don't await — runOAuthLoopback is
        // waiting for this request).
        fetch(`${redirect}?code=fake-auth-code`).catch(() => undefined);
      },
      fetchImpl: mockFetch,
    });

    const token = await promise;
    expect(capturedUrl).toBeDefined();
    expect(capturedUrl).toContain("accounts.google.com");
    expect(capturedUrl).toContain("access_type=offline");
    expect(capturedUrl).toContain("prompt=consent");
    expect(token.refresh_token).toBe("rt-xyz");
    expect(token.client_id).toBe("client-123");
    expect(token.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");

    // Token file persisted.
    const disk = JSON.parse(await readFile(tokenPath, "utf8"));
    expect(disk.refresh_token).toBe("rt-xyz");

    // Exchange call was POSTed to Google's token endpoint with the right code.
    const exchange = calls.find((c) => c.url.includes("oauth2.googleapis.com/token"));
    expect(exchange).toBeDefined();
    expect(exchange!.body).toContain("code=fake-auth-code");
    expect(exchange!.body).toContain("grant_type=authorization_code");
    expect(exchange!.body).toContain("client_id=client-123");
  });

  it("rejects when the exchange returns no refresh_token", async () => {
    const tokenPath = await mkTokenPath();
    const mockFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ scope: "x" }), { status: 200 })) as typeof fetch;

    await expect(
      runOAuthLoopback({
        clientId: "cid",
        clientSecret: "csec",
        scopes: ["x"],
        tokenPath,
        onAuthUrl: (url) => {
          const redirect = new URL(url).searchParams.get("redirect_uri")!;
          fetch(`${redirect}?code=abc`).catch(() => undefined);
        },
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/no refresh_token/);
  });

  it("surfaces an OAuth consent error from the redirect", async () => {
    const tokenPath = await mkTokenPath();
    const mockFetch: typeof fetch = (async () =>
      new Response("{}", { status: 200 })) as typeof fetch;

    await expect(
      runOAuthLoopback({
        clientId: "cid",
        clientSecret: "csec",
        scopes: ["x"],
        tokenPath,
        onAuthUrl: (url) => {
          const redirect = new URL(url).searchParams.get("redirect_uri")!;
          fetch(`${redirect}?error=access_denied`).catch(() => undefined);
        },
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/access_denied/);
  });
});
