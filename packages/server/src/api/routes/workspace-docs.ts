/**
 * Workspace docs endpoints — serve markdown docs from the bundled
 * `docs/` tree to the dashboard's docs viewer. Delegates entirely to
 * the shared `handleWorkspaceDocs` implementation in `../workspace-docs.ts`
 * because it has its own conventions (path traversal protection,
 * mime-type rules, etc.).
 *
 * - GET  /api/workspace-docs              — root listing
 * - GET  /api/workspace-docs/...          — nested file or directory
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { handleWorkspaceDocs } from "../workspace-docs.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (
    ctx.pathname !== "/api/workspace-docs" &&
    !ctx.pathname.startsWith("/api/workspace-docs/")
  ) {
    return false;
  }
  await handleWorkspaceDocs(req, res, ctx.pathname, ctx.logger);
  return true;
}
