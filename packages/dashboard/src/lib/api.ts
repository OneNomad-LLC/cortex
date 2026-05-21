/**
 * Tiny fetch wrapper that handles the dashboard's auth contract for us.
 *
 *   1. Always sends `credentials: 'include'` so the
 *      `cortex_dash_sid` HttpOnly cookie rides every request.
 *   2. Adds `X-Cortex-Dashboard: 1` on mutating methods (POST / PUT /
 *      PATCH / DELETE) — the server's CSRF gate rejects writes that
 *      lack it.
 *   3. Sets `Content-Type: application/json` automatically for JSON
 *      string bodies, but passes FormData / Blob bodies through
 *      untouched so the browser can set the multipart boundary.
 *   4. Parses JSON responses and throws on non-2xx. 401 throws
 *      `ApiUnauthorizedError` (the AuthProvider listens via window
 *      event), 403 + missing CSRF throws `ApiCsrfError`, everything
 *      else throws a generic `ApiError`.
 *
 * Designed so React Query (in `main.tsx`) and react-hook-form
 * submissions can share a single error model and a single
 * "logged-out" signal. Throwing across module boundaries is fine —
 * the AuthErrorBoundary picks it up regardless of who threw.
 */

const CSRF_HEADER = "X-Cortex-Dashboard";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ApiErrorShape {
  status: number;
  error: string;
  message?: string;
  [key: string]: unknown;
}

/** Generic non-2xx response. Carries the JSON body when one was sent. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorShape;
  constructor(body: ApiErrorShape) {
    super(body.message ?? body.error ?? `HTTP ${body.status}`);
    this.name = "ApiError";
    this.status = body.status;
    this.body = body;
  }
}

/**
 * Thrown on 401. Dashboard-wide event `cortex:unauthorized` fires
 * alongside the throw so the AuthErrorBoundary can navigate to /login
 * even when the throwing call site doesn't itself surface the error
 * (e.g. background React Query refetches).
 */
export class ApiUnauthorizedError extends ApiError {
  constructor(body: ApiErrorShape) {
    super(body);
    this.name = "ApiUnauthorizedError";
  }
}

/** Thrown on 403 csrf_required. Almost always a coding bug. */
export class ApiCsrfError extends ApiError {
  constructor(body: ApiErrorShape) {
    super(body);
    this.name = "ApiCsrfError";
  }
}

/**
 * Browser-only dispatcher. Guarded for SSR + test environments where
 * `window` may be absent — silently no-ops there so unit tests don't
 * need to mock the event bus.
 */
function dispatchUnauthorized(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("cortex:unauthorized"));
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers ?? {});

  if (MUTATING_METHODS.has(method)) {
    if (!headers.has(CSRF_HEADER)) headers.set(CSRF_HEADER, "1");
  }

  // JSON bodies: stamp Content-Type unless the caller already did.
  // FormData / Blob / URLSearchParams flow through untouched so the
  // browser can pick the right Content-Type with its own boundary.
  const body = init.body;
  if (typeof body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: init.credentials ?? "include",
  });

  // 204 / 205 — no body. Cast undefined to T; callers that expect a
  // payload should not use those status codes.
  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  let parsed: unknown;
  if (contentType.includes("application/json")) {
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
  } else {
    // Non-JSON: hand back the raw text so the caller can decide.
    parsed = await response.text().catch(() => undefined);
  }

  if (!response.ok) {
    const shape: ApiErrorShape = {
      status: response.status,
      error:
        (parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : undefined) ?? `http_${response.status}`,
      ...(parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {}),
    };

    if (response.status === 401) {
      dispatchUnauthorized();
      throw new ApiUnauthorizedError(shape);
    }
    if (response.status === 403 && shape.error === "csrf_required") {
      throw new ApiCsrfError(shape);
    }
    throw new ApiError(shape);
  }

  return parsed as T;
}

/** Helper: convenience JSON POST. */
export async function apiPost<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  return api<T>(path, {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
