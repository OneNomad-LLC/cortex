export interface CacheReadResult {
  payload: unknown;
  refreshedAt: string;
  failureCount: number;
  lastError: string | null;
}

export interface CacheStorage {
  read(
    widgetName: string,
    workspace: string,
    cacheKey: string,
  ): CacheReadResult | null;

  write(
    widgetName: string,
    workspace: string,
    cacheKey: string,
    payload: unknown,
    refreshedAt: string,
  ): void;

  recordFailure(
    widgetName: string,
    workspace: string,
    cacheKey: string,
    error: string,
  ): void;

  close(): void;
}
