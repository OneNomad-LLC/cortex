/**
 * Wizard endpoints — dashboard renders setup forms from the same
 * WizardModule specs the CLI uses (ADR-014). Submit writes to the
 * active workspace's config via the shared config-mutation service,
 * then hot-reloads so changes take effect without a restart.
 *
 * - GET  /api/wizards              — list every WizardModule spec
 * - GET  /api/wizards/:id          — fetch one spec (for form rendering)
 * - POST /api/wizards/:id/discover — run discovery (probe connectivity, suggest defaults)
 * - POST /api/wizards/:id          — apply a completed result + hot-reload
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { readJsonBody, sendJson } from "../http.js";
import { applyWizardResult } from "../../cli/config-mutation.js";
import { discoverForWizard } from "../../cli/discovery.js";
import { findRepoRoot } from "../../cli/dotenv.js";
import { findWizard, listWizards } from "../../cli/wizard-registry.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";
import { tryReload } from "../reload.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;
  if (pathname !== "/api/wizards" && !pathname.startsWith("/api/wizards/")) {
    return false;
  }

  try {
    if (req.method === "GET" && pathname === "/api/wizards") {
      const wizards = listWizards().map((w) => ({
        id: w.id,
        name: w.name,
        category: w.category,
        description: w.description,
      }));
      sendJson(res, 200, { wizards });
      return true;
    }

    if (req.method === "GET" && pathname.startsWith("/api/wizards/")) {
      const id = decodeURIComponent(pathname.slice("/api/wizards/".length));
      const wizard = findWizard(id);
      if (!wizard) {
        sendJson(res, 404, { error: `wizard '${id}' not found` });
        return true;
      }
      // configSchema is a Zod type — not JSON-serializable, and the
      // dashboard doesn't need it to render a form (the steps list
      // carries all the shape info). Strip it out.
      sendJson(res, 200, {
        id: wizard.id,
        name: wizard.name,
        category: wizard.category,
        description: wizard.description,
        steps: wizard.steps.map((s) => ({ ...s, pattern: undefined })),
        secrets: wizard.secrets ?? [],
      });
      return true;
    }

    if (
      req.method === "POST" &&
      pathname.startsWith("/api/wizards/") &&
      pathname.endsWith("/discover")
    ) {
      const id = decodeURIComponent(
        pathname.slice("/api/wizards/".length, -"/discover".length),
      );
      const wizard = findWizard(id);
      if (!wizard) {
        sendJson(res, 404, { error: `wizard '${id}' not found` });
        return true;
      }
      const body = (await readJsonBody(req)) as {
        config?: Record<string, unknown>;
        secrets?: Record<string, string>;
      };
      const result = await discoverForWizard({
        wizardId: id,
        config: body.config ?? {},
        secrets: body.secrets ?? {},
        logger: ctx.logger,
        repoRoot: findRepoRoot(process.cwd()),
      });
      sendJson(res, 200, result);
      return true;
    }

    if (req.method === "POST" && pathname.startsWith("/api/wizards/")) {
      const id = decodeURIComponent(pathname.slice("/api/wizards/".length));
      const wizard = findWizard(id);
      if (!wizard) {
        sendJson(res, 404, { error: `wizard '${id}' not found` });
        return true;
      }
      const active = await getActiveWorkspace();
      if (!active) {
        sendJson(res, 400, {
          error:
            "no active workspace — create one via POST /api/workspaces before applying wizard results",
        });
        return true;
      }

      const body = (await readJsonBody(req)) as {
        config?: Record<string, unknown>;
        secrets?: Record<string, string>;
      };

      const configInput = body.config ?? {};
      const parsed = wizard.configSchema.safeParse(configInput);
      if (!parsed.success) {
        sendJson(res, 400, {
          error: "config validation failed",
          issues: parsed.error.issues,
        });
        return true;
      }

      const derivedTaxonomy = wizard.derivedTaxonomy?.(
        configInput as Record<string, unknown>,
      );

      const result = {
        moduleId: wizard.id,
        category: wizard.category,
        config: parsed.data,
        secrets: body.secrets ?? {},
        ...(derivedTaxonomy ? { derivedTaxonomy } : {}),
      };
      const applied = await applyWizardResult(
        { repoRoot: active.path },
        result,
      );
      // Also update process.env in-memory so the hot reload below sees
      // the new secret values. Without this the write lands on disk
      // but providers/adapters that need the key at init time still
      // see undefined until the next container restart.
      for (const [k, v] of Object.entries(result.secrets)) {
        if (typeof v === "string" && v.length > 0) {
          process.env[k] = v;
        }
      }
      const reloaded = await tryReload(ctx.opts, ctx.logger);
      sendJson(res, 200, {
        applied: true,
        filesWritten: applied.filesWritten,
        reloaded,
        restartRequired: !reloaded,
        warning: reloaded
          ? undefined
          : "Config written. Restart `cortex start` (or the sidecar) so the new settings take effect.",
      });
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    ctx.logger.warn("api.wizards.failed", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
