export interface RateLimiter {
  /** Resolves when one unit of budget is available. */
  acquire(units?: number): Promise<void>;
}

export interface TokenBucketOptions {
  /** Max tokens in the bucket. */
  capacity: number;
  /** Refill rate in tokens per second. */
  refillPerSecond: number;
}

/**
 * Simple token-bucket rate limiter. Not distributed; per-adapter-instance.
 * Adequate for polling adapters that share a single process.
 *
 * TODO: wire up to adapter config (loom: 10/min, atlassian: 100/min, ...).
 */
export function tokenBucket(_opts: TokenBucketOptions): RateLimiter {
  // TODO: implement. Stubbed to no-op so adapter scaffolding compiles.
  return {
    async acquire(): Promise<void> {
      return undefined;
    },
  };
}
