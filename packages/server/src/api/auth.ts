/**
 * Request authentication for the dashboard API.
 *
 * Three accepted credentials, any one passes:
 *
 *   - `Authorization: Bearer <PRZM_CORTEX_API_AUTH_TOKEN>` — direct API
 *     access (Claude Code on MCP, scripts, etc.)
 *   - `X-Cortex-Gateway-Secret: <PRZM_CORTEX_GATEWAY_SECRET>` — server-to-
 *     server, used by the pyre-web proxy fronting the dashboard
 *   - Signed session cookie set via `/cortex-session/issue` — browser
 *     sessions handed off from pyre-web
 *
 * When neither PRZM_CORTEX_API_AUTH_TOKEN nor PRZM_CORTEX_GATEWAY_SECRET is set
 * the gate is off entirely (local dev — the operator drives the
 * dashboard from localhost). `/health` is always public so Fly's
 * machine probes can reach it.
 *
 * Constant-time compare so an attacker can't time-sidechannel either
 * token's length or contents.
 */

import type { IncomingMessage } from "node:http";
import { verifyCookie } from "./cookie-session.js";

export function apiAuthOk(req: IncomingMessage): boolean {
  const bearerExpected = process.env.PRZM_CORTEX_API_AUTH_TOKEN;
  const gatewayExpected = process.env.PRZM_CORTEX_GATEWAY_SECRET;
  if (!bearerExpected && !gatewayExpected) return true;

  if (verifyCookie(req)) return true;

  if (gatewayExpected) {
    const header = req.headers["x-cortex-gateway-secret"];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === "string" && constantTimeEqual(value, gatewayExpected)) {
      return true;
    }
  }

  if (bearerExpected) {
    const header = req.headers["authorization"];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === "string") {
      const match = /^Bearer\s+(.+)$/i.exec(value);
      if (match && constantTimeEqual(match[1]!, bearerExpected)) {
        return true;
      }
    }
  }

  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
