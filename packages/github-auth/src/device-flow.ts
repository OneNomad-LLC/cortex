import { z } from "zod";

/**
 * GitHub OAuth Device Flow. No client_secret needed — the user types
 * a short code into github.com/login/device, authorizes the app, and
 * Cortex polls until GitHub says the grant is complete.
 *
 * Reference: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

const deviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});

export interface DeviceCodeGrant {
  deviceCode: string;
  /** Short code the user types in the browser (e.g. "ABCD-1234"). */
  userCode: string;
  /** URL to open: typically https://github.com/login/device */
  verificationUri: string;
  expiresAt: Date;
  pollIntervalSeconds: number;
}

const tokenResponseSchema = z.union([
  z.object({
    access_token: z.string().min(1),
    scope: z.string().default(""),
    token_type: z.string().default("bearer"),
  }),
  z.object({
    error: z.string(),
    error_description: z.string().optional(),
  }),
]);

export interface DeviceFlowOptions {
  clientId: string;
  /** OAuth scopes. Default: `repo` for full repo access. */
  scopes?: readonly string[];
  fetchImpl?: typeof fetch;
}

export interface DeviceFlowStarter {
  start(): Promise<DeviceCodeGrant>;
  /**
   * Poll the token endpoint until GitHub returns a token, the user
   * denies, or the grant expires. Resolves with the token string on
   * success.
   */
  poll(grant: DeviceCodeGrant): Promise<{ accessToken: string; scopes: string[] }>;
}

export function createDeviceFlow(opts: DeviceFlowOptions): DeviceFlowStarter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const scope = (opts.scopes ?? ["repo"]).join(" ");

  return {
    async start(): Promise<DeviceCodeGrant> {
      const body = new URLSearchParams({
        client_id: opts.clientId,
        scope,
      });
      const res = await fetchImpl(DEVICE_CODE_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `GitHub device-code request failed: ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
        );
      }
      const parsed = deviceCodeResponseSchema.parse(await res.json());
      return {
        deviceCode: parsed.device_code,
        userCode: parsed.user_code,
        verificationUri: parsed.verification_uri,
        expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
        pollIntervalSeconds: parsed.interval,
      };
    },

    async poll(grant) {
      const body = new URLSearchParams({
        client_id: opts.clientId,
        device_code: grant.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      let intervalMs = grant.pollIntervalSeconds * 1000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (Date.now() >= grant.expiresAt.getTime()) {
          throw new Error(
            "GitHub device flow expired before the grant was approved. Run `cortex github-login` again.",
          );
        }
        await new Promise((r) => setTimeout(r, intervalMs));
        const res = await fetchImpl(TOKEN_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });
        const json = (await res.json().catch(() => ({}))) as unknown;
        const parsed = tokenResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw new Error(
            `Unexpected response from GitHub token endpoint: ${JSON.stringify(json).slice(0, 300)}`,
          );
        }
        const data = parsed.data;
        if ("access_token" in data) {
          return {
            accessToken: data.access_token,
            scopes: data.scope.split(/[\s,]+/).filter(Boolean),
          };
        }
        // Handle the expected "waiting" error codes — everything else is fatal.
        switch (data.error) {
          case "authorization_pending":
            // User hasn't entered the code yet. Keep polling.
            continue;
          case "slow_down":
            // GitHub wants us to back off. Spec says add 5s.
            intervalMs += 5_000;
            continue;
          case "expired_token":
            throw new Error(
              "GitHub reported the device code expired. Start `cortex github-login` again.",
            );
          case "access_denied":
            throw new Error(
              "You denied the authorization request. Nothing changed.",
            );
          default:
            throw new Error(
              `GitHub device-flow error: ${data.error}${data.error_description ? ` — ${data.error_description}` : ""}`,
            );
        }
      }
    },
  };
}
