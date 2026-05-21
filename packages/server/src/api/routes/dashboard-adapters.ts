/**
 * Dashboard-scoped adapter management. Sits behind `requireDashboardAuth`
 * (admin) so the SPA can manage adapter lifecycle without touching the
 * gateway-secret-gated `/api/wizards` + `/api/adapters/:id/sync` pair.
 *
 * Surface:
 *   GET    /api/dashboard/adapters              — every configured adapter
 *          → { adapters: Array<{ id, kind, slug, status, lastRunAt?, lastError? }> }
 *   GET    /api/dashboard/adapters/:id          — one adapter's full detail
 *          (secrets redacted with the literal "__REDACTED__" sentinel —
 *           the wizard renderer renders that as "Click to replace")
 *   POST   /api/dashboard/adapters/:id/pause    — set enabled=false in cortex.yaml + reload
 *   POST   /api/dashboard/adapters/:id/resume   — set enabled=true + reload
 *   POST   /api/dashboard/adapters/:id/trigger-fetch
 *          — fire the live adapter's fetch+transform+classify+ingest pass
 *            inline; returns the sync result so the UI can toast it.
 *   DELETE /api/dashboard/adapters/:id          — remove from cortex.yaml +
 *          drop the adapter's declared secrets from .env
 *
 * Status enum: `idle` (configured, not currently running, no last-error),
 * `running`, `paused` (entry present but `enabled=false`), `error` (last
 * heartbeat run reported errors).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RouteContext } from "../route-context.js";
import { sendJson } from "../http.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import { findWizard } from "../../cli/wizard-registry.js";
import { loadCortexConfig, resolveLocalFirst } from "../../config.js";
import { resolveConfigPath } from "../../cli/config-path.js";
import { removeEnvKeys } from "../../cli/config-mutation.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";
import { tryReload } from "../reload.js";
import { runSync } from "../../sync.js";

const REDACTED_SENTINEL = "__REDACTED__";

type AdapterStatus = "idle" | "running" | "paused" | "error";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;
  if (!pathname.startsWith("/api/dashboard/adapters")) return false;

  const gate = requireDashboardAuth(["admin"]);
  const resolved = await gate(req, res);
  if (!resolved) return true;

  try {
    if (req.method === "GET" && pathname === "/api/dashboard/adapters") {
      return await handleList(res, ctx);
    }

    const detailMatch = pathname.match(/^\/api\/dashboard\/adapters\/([^/]+)$/);
    if (req.method === "GET" && detailMatch) {
      return await handleDetail(res, ctx, decodeURIComponent(detailMatch[1]!));
    }
    if (req.method === "DELETE" && detailMatch) {
      return await handleDelete(res, ctx, decodeURIComponent(detailMatch[1]!));
    }

    const pauseMatch = pathname.match(
      /^\/api\/dashboard\/adapters\/([^/]+)\/pause$/,
    );
    if (req.method === "POST" && pauseMatch) {
      return await handleToggle(
        res,
        ctx,
        decodeURIComponent(pauseMatch[1]!),
        false,
      );
    }
    const resumeMatch = pathname.match(
      /^\/api\/dashboard\/adapters\/([^/]+)\/resume$/,
    );
    if (req.method === "POST" && resumeMatch) {
      return await handleToggle(
        res,
        ctx,
        decodeURIComponent(resumeMatch[1]!),
        true,
      );
    }
    const triggerMatch = pathname.match(
      /^\/api\/dashboard\/adapters\/([^/]+)\/trigger-fetch$/,
    );
    if (req.method === "POST" && triggerMatch) {
      return await handleTriggerFetch(
        res,
        ctx,
        decodeURIComponent(triggerMatch[1]!),
      );
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    ctx.logger.warn("api.dashboard_adapters.failed", {
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

async function handleList(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const cfg = await loadCortexConfig(resolveConfigPath());
  const heartbeatSnap = ctx.opts.heartbeat?.snapshot();
  const adapters = Object.entries(cfg.adapters).map(([id, entry]) => {
    const wizard = findWizard(id);
    const status = computeStatus(id, entry.enabled, heartbeatSnap);
    const adapterStats = heartbeatSnap?.adapters?.[id];
    return {
      id,
      kind: "adapter" as const,
      slug: id,
      name: wizard?.name ?? id,
      package: entry.package,
      enabled: entry.enabled,
      status,
      schedule: entry.schedule ?? null,
      lastRunAt: adapterStats?.lastRunAt ?? null,
      lastRunIngested: adapterStats?.lastRunIngested ?? null,
      lastError:
        adapterStats && adapterStats.errors > 0
          ? `${adapterStats.errors} error(s) on last run`
          : null,
    };
  });
  sendJson(res, 200, { adapters });
  return true;
}

function computeStatus(
  id: string,
  enabled: boolean,
  heartbeatSnap: ReturnType<NonNullable<RouteContext["opts"]["heartbeat"]>["snapshot"]> | undefined,
): AdapterStatus {
  if (!enabled) return "paused";
  const stats = heartbeatSnap?.adapters?.[id];
  if (stats?.running) return "running";
  if (stats && stats.errors > 0) return "error";
  return "idle";
}

async function handleDetail(
  res: ServerResponse,
  ctx: RouteContext,
  id: string,
): Promise<boolean> {
  const cfg = await loadCortexConfig(resolveConfigPath());
  const entry = cfg.adapters[id];
  if (!entry) {
    sendJson(res, 404, { error: `adapter '${id}' not configured` });
    return true;
  }
  const wizard = findWizard(id);

  // Build a redacted secrets map. The renderer is expected to display
  // each declared secret with a "[Redacted — click to replace]" affordance
  // when the value is `__REDACTED__`. Secrets that aren't configured at
  // all come back as empty string so the UI can prompt the user normally.
  const secrets: Record<string, string> = {};
  for (const spec of wizard?.secrets ?? []) {
    const present = process.env[spec.envVar];
    secrets[spec.envVar] =
      typeof present === "string" && present.length > 0
        ? REDACTED_SENTINEL
        : "";
  }

  const heartbeatSnap = ctx.opts.heartbeat?.snapshot();
  const adapterStats = heartbeatSnap?.adapters?.[id];
  sendJson(res, 200, {
    id,
    kind: "adapter",
    slug: id,
    name: wizard?.name ?? id,
    description: wizard?.description ?? null,
    package: entry.package,
    enabled: entry.enabled,
    schedule: entry.schedule ?? null,
    config: entry.config,
    secrets,
    status: computeStatus(id, entry.enabled, heartbeatSnap),
    lastRunAt: adapterStats?.lastRunAt ?? null,
    lastRunIngested: adapterStats?.lastRunIngested ?? null,
    lastError:
      adapterStats && adapterStats.errors > 0
        ? `${adapterStats.errors} error(s) on last run`
        : null,
  });
  return true;
}

/**
 * Flip `enabled` on an adapter entry. Goes through `.local.yaml` overlay
 * so the change survives template rewrites. Mirror of the toggle helper
 * in `routes/config.ts` but locked to the adapter category.
 */
async function handleToggle(
  res: ServerResponse,
  ctx: RouteContext,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const cfgPath = resolveConfigPath();
  const effectivePath = await resolveLocalFirst(cfgPath);
  const raw = await readFile(effectivePath, "utf8");
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const adapters = parsed.adapters as Record<string, unknown> | undefined;
  if (!adapters || typeof adapters !== "object") {
    sendJson(res, 404, { error: `adapter '${id}' not configured` });
    return true;
  }
  const entry = adapters[id];
  if (!entry || typeof entry !== "object") {
    sendJson(res, 404, { error: `adapter '${id}' not configured` });
    return true;
  }
  (entry as Record<string, unknown>).enabled = enabled;
  await writeFile(effectivePath, stringifyYaml(parsed), "utf8");
  const reloaded = await tryReload(ctx.opts, ctx.logger);
  ctx.logger.info("api.dashboard_adapters.toggle", { id, enabled, reloaded });
  sendJson(res, 200, { ok: true, id, enabled, reloaded });
  return true;
}

async function handleTriggerFetch(
  res: ServerResponse,
  ctx: RouteContext,
  id: string,
): Promise<boolean> {
  const adapter = ctx.opts.adapters?.[id];
  if (!adapter) {
    sendJson(res, 404, {
      error: `adapter '${id}' is not currently registered — enable it and trigger a reload first`,
    });
    return true;
  }
  ctx.opts.heartbeat?.markRunBegin(adapter.id);
  const startedAt = Date.now();
  try {
    const result = await runSync({
      adapter,
      engram: ctx.opts.engram,
      logger: ctx.logger,
      ...(ctx.opts.llmRouter ? { llmRouter: ctx.opts.llmRouter } : {}),
      taxonomy: ctx.opts.taxonomy,
      opts: {},
    });
    const durationMs = Date.now() - startedAt;
    ctx.opts.heartbeat?.markRunEnd(adapter.id, {
      ingested: result.ingested,
      errors: result.errors,
      durationMs,
    });
    ctx.logger.info("api.dashboard_adapters.trigger_fetch.done", {
      id,
      durationMs,
      ...result,
    });
    // Synchronous result keeps the SPA simple — no job polling required.
    // For long-running adapters the dashboard can show a spinner against
    // the response; if we ever need true async we add a job id here and
    // a /api/dashboard/jobs/:id status endpoint.
    sendJson(res, 200, { ok: true, durationMs, ...result });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    ctx.opts.heartbeat?.markRunEnd(adapter.id, {
      ingested: 0,
      errors: 1,
      durationMs,
    });
    ctx.logger.error("api.dashboard_adapters.trigger_fetch.failed", {
      id,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      ok: false,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

async function handleDelete(
  res: ServerResponse,
  ctx: RouteContext,
  id: string,
): Promise<boolean> {
  const cfgPath = resolveConfigPath();
  const effectivePath = await resolveLocalFirst(cfgPath);
  const raw = await readFile(effectivePath, "utf8");
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const adapters = parsed.adapters as Record<string, unknown> | undefined;
  if (!adapters || typeof adapters !== "object" || !(id in adapters)) {
    sendJson(res, 404, { error: `adapter '${id}' not configured` });
    return true;
  }
  delete (adapters as Record<string, unknown>)[id];
  await writeFile(effectivePath, stringifyYaml(parsed), "utf8");

  // Drop secrets declared by the wizard from .env. We only touch keys
  // this wizard owns — leaving unrelated env entries (gateway secret,
  // PG conn string, etc.) alone.
  const wizard = findWizard(id);
  let removedSecrets: string[] = [];
  if (wizard?.secrets?.length) {
    const active = await getActiveWorkspace();
    if (active) {
      const envPath = path.join(active.path, ".env");
      removedSecrets = await removeEnvKeys(
        envPath,
        wizard.secrets.map((s) => s.envVar),
      );
    }
  }

  const reloaded = await tryReload(ctx.opts, ctx.logger);
  ctx.logger.info("api.dashboard_adapters.delete", {
    id,
    removedSecrets,
    reloaded,
  });
  sendJson(res, 200, {
    ok: true,
    id,
    removedSecrets,
    reloaded,
  });
  return true;
}
