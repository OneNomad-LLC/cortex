/**
 * Thin fetch layer for the cortex start HTTP sidecar.
 *
 * Client components go through Next.js rewrites at `/api/cortex/*`; the
 * next.config rewrites forward to `${CORTEX_API_URL}/api/*`. Server
 * components bypass the rewrite and call the sidecar directly.
 *
 * Auth on server-side fetches: when CORTEX_GATEWAY_SECRET is set on the
 * dashboard child's env (every Cortex Cloud deployment ships it through
 * pyre-web's deploy action), every internal RSC fetch attaches the
 * `x-cortex-gateway-secret` header so apiAuthOk on the sidecar honors
 * it. Without this header, RSC fetches lack a credential — the browser
 * cookie that authenticated the user lives in the browser, not the
 * dashboard process — and 401 immediately. Local-dev installs without
 * the secret env var fall through unauthenticated, which is fine
 * because the sidecar's apiAuthOk leaves the gate open when no auth
 * env vars are set.
 */

const SERVER_BASE = process.env.CORTEX_API_URL ?? "http://127.0.0.1:4141";
const GATEWAY_SECRET = process.env.CORTEX_GATEWAY_SECRET;

function serverHeaders(extra?: HeadersInit): HeadersInit {
  if (!GATEWAY_SECRET) return extra ?? {};
  const out: Record<string, string> = { "x-cortex-gateway-secret": GATEWAY_SECRET };
  if (extra) {
    if (extra instanceof Headers) {
      extra.forEach((value, key) => { out[key] = value; });
    } else if (Array.isArray(extra)) {
      for (const [key, value] of extra) out[key] = value;
    } else {
      Object.assign(out, extra);
    }
  }
  return out;
}

export type WidgetFetcher = <T>(
  widget: string,
  params?: Record<string, string | number>,
) => Promise<T>;

function buildQuery(params?: Record<string, string | number>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : "";
}

/**
 * Server-side fetcher: used inside Server Components and Route Handlers.
 * Talks straight to the sidecar; no rewrite needed.
 */
export const fetchWidgetServer: WidgetFetcher = async <T>(
  widget: string,
  params?: Record<string, string | number>,
): Promise<T> => {
  const url = `${SERVER_BASE}/api/widgets/${widget}${buildQuery(params)}`;
  const res = await fetch(url, { cache: "no-store", headers: serverHeaders() });
  if (!res.ok) {
    throw new Error(`widget ${widget}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
};

/**
 * Client-side fetcher: used inside Client Components. Routes through the
 * Next.js proxy so browsers hit same-origin.
 */
export const fetchWidgetClient: WidgetFetcher = async <T>(
  widget: string,
  params?: Record<string, string | number>,
): Promise<T> => {
  const url = `/api/cortex/widgets/${widget}${buildQuery(params)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`widget ${widget}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
};

/**
 * Fetches the resolved dashboard layout from the sidecar. Server-side
 * only; mirrors `fetchWidgetServer`'s shape.
 */
export async function fetchLayoutServer<T>(): Promise<T> {
  const url = `${SERVER_BASE}/api/layout`;
  const res = await fetch(url, { cache: "no-store", headers: serverHeaders() });
  if (!res.ok) {
    throw new Error(`layout: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Server-side helper for the per-workspace docs API. The dashboard
 * container can't read the host filesystem where workspace docs live,
 * so we always go through the cortex sidecar.
 */
export async function fetchCortexJsonServer<T>(
  apiPath: string,
  init?: { signal?: AbortSignal },
): Promise<T> {
  const url = `${SERVER_BASE}${apiPath}`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: serverHeaders(),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`${apiPath}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Invoke a Cortex MCP tool from a client component. Posts to the
 * sidecar's tool endpoint via the same `/api/cortex/*` rewrite the
 * widget fetchers use, and unwraps the `{ result, error }` envelope
 * the sidecar returns.
 *
 * Throws when the response is non-2xx OR when the envelope is missing
 * `result` (server convention: tools that succeed always populate
 * `result`, even if the value is `null`).
 */
export async function invokeMcpTool<T>(
  name: string,
  input: Record<string, unknown>,
): Promise<T> {
  const r = await fetch(
    `/api/cortex/mcp/tools/${encodeURIComponent(name)}/invoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
  const body = (await r.json().catch(() => ({}))) as {
    result?: T;
    error?: string;
  };
  if (!r.ok) {
    throw new Error(body.error ?? `${r.status} ${r.statusText}`);
  }
  if (body.result === undefined) {
    throw new Error("missing result");
  }
  return body.result;
}
