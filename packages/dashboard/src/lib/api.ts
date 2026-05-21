/**
 * Tiny fetch wrapper used by the dashboard SPA. Every call automatically:
 *
 *   1. Sends `credentials: "include"` so the `cortex_dash_sid` cookie
 *      rides along.
 *   2. Stamps the `X-Cortex-Dashboard: 1` CSRF header on mutating verbs
 *      (the gate in `requireDashboardAuth` rejects writes without it).
 *   3. Parses JSON bodies and throws an `ApiError` with the server's
 *      message on non-2xx — saves every caller from repeating the
 *      error-shape unpacking.
 *
 * Lives in `lib/` because both pages and the WizardForm callers need
 * it. Keep it framework-agnostic — no React, no Query types — so the
 * tests can call it from plain functions without a React tree.
 */

export interface ApiErrorBody {
  error?: string;
  errors?: Record<string, string>;
  [k: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(message: string, status: number, body: ApiErrorBody) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type Method = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";

interface ApiOptions {
  method?: Method;
  body?: unknown;
  signal?: AbortSignal;
}

const MUTATING: ReadonlySet<Method> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function api<T = unknown>(
  path: string,
  opts: ApiOptions = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (MUTATING.has(method)) {
    headers["x-cortex-dashboard"] = "1";
  }

  const init: RequestInit = {
    method,
    credentials: "include",
    headers,
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  if (opts.signal) {
    init.signal = opts.signal;
  }

  const res = await fetch(path, init);
  const ct = res.headers.get("content-type") ?? "";
  let parsed: unknown;
  if (ct.includes("application/json")) {
    parsed = await res.json().catch(() => undefined);
  } else {
    parsed = await res.text().catch(() => undefined);
  }
  if (!res.ok) {
    const body = (parsed ?? {}) as ApiErrorBody;
    const message =
      typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new ApiError(message, res.status, body);
  }
  return parsed as T;
}
