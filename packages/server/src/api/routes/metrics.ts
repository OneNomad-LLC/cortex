/**
 * Prometheus scrape endpoint.
 *
 * - GET /metrics
 *
 * Returns all registered cortex metrics (plus Node.js runtime metrics) in
 * Prometheus text exposition format. Protected by the same bearer-token
 * auth gate as every other /api/* route — configure your Prometheus scraper
 * to send `Authorization: Bearer <PRZM_CORTEX_API_AUTH_TOKEN>` or set up
 * a network-level control (Tailscale, VPC) so the scraper runs next to the
 * server without a token.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { metricsRegistry } from "../../metrics.js";

export async function handle(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (ctx.pathname !== "/metrics") return false;

  try {
    const output = await metricsRegistry.metrics();
    res.setHeader("Content-Type", metricsRegistry.contentType);
    res.statusCode = 200;
    res.end(output);
  } catch (err) {
    ctx.logger.warn("api.metrics.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.statusCode = 500;
    res.end();
  }
  return true;
}
