/**
 * Usage tracker for cortex server (Task #15 — initial-ingest credit).
 *
 * Provides `OnIngestUsage` callbacks that wire into the pgvector backend.
 * Two implementations:
 *
 *   createNullTracker()            — no-op, for embedded / test mode.
 *   createPrzmAccessTracker(…)     — ships events to przm-access's admin
 *                                    usage API for billing ledger + Stripe.
 *
 * The callback is fire-and-forget: the backend catches errors and logs them
 * as warnings, so a billing-plane outage never breaks ingest.
 *
 * Usage in server setup:
 *
 *   const tracker = PRZM_ACCESS_URL && PRZM_ACCESS_ADMIN_KEY
 *     ? createPrzmAccessTracker(PRZM_ACCESS_URL, PRZM_ACCESS_ADMIN_KEY)
 *     : createNullTracker();
 *
 *   const backend = createPgVectorBackend({
 *     ...,
 *     onIngestUsage: tracker.onIngestUsage,
 *   });
 */

import type {
  OnIngestUsage,
} from "@onenomad/przm-cortex-memory-pgvector";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface UsageTracker {
  /**
   * OnIngestUsage callback ready to pass to `PgVectorBackendOptions`.
   * Fires after each successful ingest of a (tenantId, sourceId) pair.
   */
  readonly onIngestUsage: OnIngestUsage;
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

/**
 * No-op tracker. Usage events are silently discarded.
 * Use in embedded / single-tenant installs and in tests.
 */
export function createNullTracker(): UsageTracker {
  return {
    onIngestUsage: () => undefined,
  };
}

/**
 * Tracker that ships extractor-token usage events to przm-access's admin
 * usage API (`POST /admin/usage/event`). przm-access stores the event in the
 * usage_ledger and later flushes billable (non-initial) events to Stripe.
 *
 * @param baseUrl  - Base URL of the przm-access service (no trailing slash),
 *                   e.g. `https://access.przm.sh`.
 * @param adminKey - Value of `PRZM_ACCESS_ADMIN_API_KEY` on the access service.
 */
export function createPrzmAccessTracker(
  baseUrl: string,
  adminKey: string,
): UsageTracker {
  const endpoint = `${baseUrl}/admin/usage/event`;

  const onIngestUsage: OnIngestUsage = async (event) => {
    const body = JSON.stringify({
      tenantId: event.tenantId,
      sourceId: event.sourceId,
      // Each ingest event represents extractor-token usage. Content byte-length
      // is the proxy quantity — the billing plane treats 1 byte ≈ 1 token unit.
      meterName: "extractor_tokens",
      quantity: event.contentLength,
      isInitial: event.isInitial,
    });

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The access service accepts both `Authorization: Bearer <k>` and
        // `X-Admin-Key: <k>`; use the standard header.
        authorization: `Bearer ${adminKey}`,
      },
      body,
    });

    if (!res.ok) {
      // 400 = tenant has no org (unprovisioned self-hosted install) — expected
      // and not actionable from here. Any other non-2xx is unexpected.
      if (res.status !== 400) {
        throw new Error(
          `przm-access usage API returned ${res.status}: ${await res.text().catch(() => "(unreadable)")}`,
        );
      }
    }
  };

  return { onIngestUsage };
}
