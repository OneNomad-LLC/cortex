import { LLMError } from "@onenomad/cortex-llm-core";

export interface RetryOptions {
  maxAttempts?: number;
  /** Initial backoff in ms. Doubles each attempt (capped at `maxDelayMs`). */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Signal to abort retry loop early. */
  signal?: AbortSignal;
}

/**
 * Retry a fallible async op with exponential backoff. Only retries on
 * `LLMError.isRetryable`; other errors surface immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initialDelay = opts.initialDelayMs ?? 250;
  const maxDelay = opts.maxDelayMs ?? 4_000;

  let attempt = 0;
  let delay = initialDelay;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      if (err instanceof LLMError && !err.isRetryable) throw err;
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
