/**
 * Shared HTTP helpers used by every route file. Kept tiny on purpose —
 * if it doesn't fit in this file, it belongs in a route module.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Write a JSON response with the right content-type. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Read the request body as JSON. Returns `{}` for empty bodies; throws on malformed JSON. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("body is not valid JSON");
  }
}

/**
 * Set CORS headers. We accept localhost (dashboard dev), chrome-extension
 * origins (the Cortex browser extension), and fall back to `*` for
 * anything else — the localhost bind is the real security boundary, not
 * the origin check.
 */
export function setCors(res: ServerResponse, origin: string | undefined): void {
  const allow =
    origin &&
    (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
      /^(chrome|moz|safari-web)-extension:\/\/[a-zA-Z0-9-]+$/.test(origin))
      ? origin
      : "*";
  res.setHeader("access-control-allow-origin", allow);
  res.setHeader(
    "access-control-allow-methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "access-control-allow-headers",
    "content-type, authorization, x-cortex-source",
  );
  res.setHeader("vary", "origin");
}
