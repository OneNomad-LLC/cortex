export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Return true for errors that should be retried. Default: retry all. */
  shouldRetry?: (err: unknown) => boolean;
  signal?: AbortSignal;
}

/**
 * Exponential-backoff retry for adapter API calls. Mirrors `@onenomad/przm-cortex-llm-sdk`'s
 * helper but without the LLM-specific error kinds.
 *
 * TODO: add jitter, respect Retry-After headers where surfaced in errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initialDelay = opts.initialDelayMs ?? 250;
  const maxDelay = opts.maxDelayMs ?? 4_000;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let attempt = 0;
  let delay = initialDelay;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      if (!shouldRetry(err)) throw err;
      if (opts.signal?.aborted) throw err;
      await sleep(Math.min(delay, maxDelay), opts.signal);
      delay *= 2;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
