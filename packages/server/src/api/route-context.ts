/**
 * Shared context every route handler gets. Built once per request by
 * the dispatcher in server.ts; route handlers destructure what they need.
 *
 * Adding a new dependency? Add it here, wire it up in server.ts's
 * `buildContext()`, and any route that needs it just pulls it off `ctx`.
 */

import type { Logger } from "@onenomad/przm-cortex-core";
import type { Widget, WidgetContext } from "./types.js";
import type { DashboardApiOptions } from "./server.js";

export interface RouteContext {
  /** Original options passed to createDashboardApi — full surface for routes that need adapters, heartbeat, reload, etc. */
  opts: DashboardApiOptions;
  /** Request-scoped logger (child of opts.logger with `reqId` bound). */
  logger: Logger;
  /** Parsed URL — `url.pathname` and `url.searchParams` are the common reads. */
  url: URL;
  /** Convenience: `url.pathname`. */
  pathname: string;
  /** Widget registry built once at startup. */
  widgets: readonly Widget[];
  /** Same widgets, keyed by name. */
  widgetsByName: ReadonlyMap<string, Widget>;
  /** Base widget invocation context (logger gets overridden per-widget at call time). */
  widgetCtx: WidgetContext;
}

/**
 * Every route handler has this shape. Returns `true` when the URL was
 * matched (whether the handler succeeded or returned 4xx/5xx), `false`
 * to fall through to the next handler in the dispatcher chain.
 *
 * The dispatcher tries handlers in order. The first to return `true`
 * wins. If none match, server.ts sends a 404.
 */
export type RouteHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  ctx: RouteContext,
) => Promise<boolean>;
