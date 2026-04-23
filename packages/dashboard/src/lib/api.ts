/**
 * Thin fetch layer for the cortex start HTTP sidecar.
 *
 * Client components go through Next.js rewrites at `/api/cortex/*`; the
 * next.config rewrites forward to `${CORTEX_API_URL}/api/*`. Server
 * components bypass the rewrite and call the sidecar directly.
 */

const SERVER_BASE = process.env.CORTEX_API_URL ?? "http://127.0.0.1:4141";

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
  const res = await fetch(url, { cache: "no-store" });
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
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`layout: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}
