/**
 * Thin fetch wrapper that adds the CSRF header every mutating call
 * needs (`X-Cortex-Dashboard: 1`) and parses JSON. Auth rides on the
 * `cortex_dash_sid` cookie set by `POST /api/dashboard/auth/login`, so
 * no token is plumbed through callers explicitly.
 */

export type ApiError = {
  status: number;
  error: string;
  message?: string;
};

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.method && init.method.toUpperCase() !== "GET") {
    headers.set("x-cortex-dashboard", "1");
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }
  const resp = await fetch(path, { ...init, headers, credentials: "include" });
  const ct = resp.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await resp.json() : await resp.text();
  if (!resp.ok) {
    const err: ApiError = {
      status: resp.status,
      error: typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `http_${resp.status}`,
      ...(typeof body === "object" && body !== null && "message" in body
        ? { message: String((body as Record<string, unknown>).message) }
        : {}),
    };
    throw err;
  }
  return body as T;
}
