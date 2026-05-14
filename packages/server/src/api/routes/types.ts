/**
 * Memory-type registry endpoints — power the Settings → Memory types tab.
 * Built-in types are always returned but never editable; custom types
 * can be added (or auto-discovered types promoted to config) and removed.
 *
 * - GET    /api/types          — list built-in + custom merged with origin
 * - POST   /api/types          — register a custom type (or promote auto → config)
 * - DELETE /api/types/:slug    — remove a custom type
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { readJsonBody, sendJson } from "../http.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;

  if (pathname === "/api/types") {
    if (req.method === "GET") {
      sendJson(res, 200, { types: ctx.opts.memoryTypes.list() });
      return true;
    }
    if (req.method === "POST") {
      const body = (await readJsonBody(req)) as {
        slug?: unknown;
        label?: unknown;
        description?: unknown;
      } | null;
      const raw = typeof body?.slug === "string" ? body.slug : "";
      const label =
        typeof body?.label === "string" && body.label.length > 0
          ? body.label
          : undefined;
      const description =
        typeof body?.description === "string" && body.description.length > 0
          ? body.description
          : undefined;
      const slug = ctx.opts.memoryTypes.register(raw, {
        source: "config",
        ...(label !== undefined ? { label } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      if (!slug) {
        sendJson(res, 400, {
          error: "slug is required and must normalize to non-empty [a-z0-9_]",
        });
        return true;
      }
      sendJson(res, 201, { slug, types: ctx.opts.memoryTypes.list() });
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const deleteMatch = pathname.match(/^\/api\/types\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const slug = decodeURIComponent(deleteMatch[1]!);
    if (ctx.opts.memoryTypes.isBuiltIn(slug)) {
      sendJson(res, 400, {
        error: `'${slug}' is a built-in type and cannot be removed`,
      });
      return true;
    }
    const removed = ctx.opts.memoryTypes.remove(slug);
    if (!removed) {
      sendJson(res, 404, { error: `unknown custom type '${slug}'` });
      return true;
    }
    sendJson(res, 200, {
      removed: slug,
      types: ctx.opts.memoryTypes.list(),
    });
    return true;
  }

  return false;
}
