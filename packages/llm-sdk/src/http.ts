import { LLMError } from "@onenomad/cortex-llm-core";

export interface HttpFetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  /** Request timeout in ms. Default 60_000. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Provider id for typed error mapping. */
  provider: string;
}

/**
 * Thin `fetch` wrapper with a timeout and `LLMError` mapping. Returns parsed
 * JSON on 2xx; throws `LLMError` with an appropriate `kind` otherwise.
 */
export async function httpFetch<T>(
  url: string,
  opts: HttpFetchOptions,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("timeout")),
    opts.timeoutMs ?? 60_000,
  );
  const signal = combineSignals(controller.signal, opts.signal);

  let res: Response;
  try {
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(opts.headers ?? {}),
      },
      signal,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    res = await fetch(url, init);
  } catch (err) {
    clearTimeout(timeout);
    if (
      err instanceof Error &&
      (err.name === "AbortError" || /abort/i.test(err.message))
    ) {
      const kind = opts.signal?.aborted ? "aborted" : "timeout";
      throw new LLMError(
        `${opts.provider}: ${kind} calling ${url}`,
        kind,
        opts.provider,
        err,
      );
    }
    throw new LLMError(
      `${opts.provider}: unreachable (${(err as Error)?.message ?? err})`,
      "unreachable",
      opts.provider,
      err,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const bodyText = await safeText(res);
    throw new LLMError(
      `${opts.provider}: HTTP ${res.status} ${res.statusText} - ${bodyText}`,
      mapStatus(res.status),
      opts.provider,
    );
  }

  return (await res.json()) as T;
}

function mapStatus(status: number): LLMError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "provider_error";
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}

function combineSignals(
  a: AbortSignal,
  b?: AbortSignal,
): AbortSignal {
  if (!b) return a;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
