/**
 * Config-surface endpoints powering the dashboard settings screens.
 * Reads come from the on-disk cortex.yaml; writes go to the `.local.yaml`
 * overlay when one exists so they survive base-config rewrites.
 *
 * Toggles + schedule edits hot-reload the running server so changes
 * take effect immediately. Wizard applies are routed through
 * `routes/wizards.ts` instead.
 *
 * - GET  /api/config                              — full cortex.yaml (raw + parsed)
 * - GET  /api/config/adapters                     — all adapters with enabled state
 * - GET  /api/config/adapters/:id                 — one adapter's current config
 * - POST /api/config/adapters/:id/toggle          — flip enabled bit + hot-reload
 * - POST /api/config/adapters/:id/schedule        — patch cron expression + hot-reload
 * - GET  /api/config/providers                    — all providers with enabled state
 * - GET  /api/config/providers/:id                — one provider's current config
 * - POST /api/config/providers/:id/toggle         — flip enabled bit + hot-reload
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RouteContext } from "../route-context.js";
import { readJsonBody, sendJson } from "../http.js";
import { findWizard, listWizards } from "../../cli/wizard-registry.js";
import { loadCortexConfig, resolveLocalFirst } from "../../config.js";
import { resolveConfigPath } from "../../cli/config-path.js";
import { tryReload } from "../reload.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;
  if (pathname !== "/api/config" && !pathname.startsWith("/api/config/")) {
    return false;
  }

  try {
    const cfgPath = resolveConfigPath();

    if (req.method === "GET" && pathname === "/api/config") {
      const raw = await readFile(cfgPath, "utf8").catch(() => "");
      const cfg = await loadCortexConfig(cfgPath).catch(() => undefined);
      sendJson(res, 200, { path: cfgPath, raw, parsed: cfg });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/config/adapters") {
      const cfg = await loadCortexConfig(cfgPath);
      const adapters = listWizards()
        .filter((w) => w.category === "adapter")
        .map((w) => {
          const entry = cfg.adapters?.[w.id];
          return {
            id: w.id,
            name: w.name,
            description: w.description,
            enabled: entry?.enabled === true,
            configured: Boolean(entry),
            schedule: entry?.schedule ?? null,
          };
        });
      sendJson(res, 200, { adapters });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/config/providers") {
      const cfg = await loadCortexConfig(cfgPath);
      const providers = listWizards()
        .filter((w) => w.category === "provider")
        .map((w) => {
          const entry = cfg.llm?.providers?.[w.id];
          return {
            id: w.id,
            name: w.name,
            description: w.description,
            enabled: entry?.enabled === true,
            configured: Boolean(entry),
          };
        });
      sendJson(res, 200, { providers });
      return true;
    }

    const adapterGet = pathname.match(/^\/api\/config\/adapters\/([^/]+)$/);
    if (req.method === "GET" && adapterGet) {
      const id = decodeURIComponent(adapterGet[1]!);
      const cfg = await loadCortexConfig(cfgPath);
      const entry = cfg.adapters?.[id];
      sendJson(res, 200, {
        id,
        enabled: entry?.enabled === true,
        configured: Boolean(entry),
        config: entry?.config ?? {},
        schedule: entry?.schedule ?? null,
        secretsConfigured: listConfiguredSecrets(id),
      });
      return true;
    }
    const providerGet = pathname.match(/^\/api\/config\/providers\/([^/]+)$/);
    if (req.method === "GET" && providerGet) {
      const id = decodeURIComponent(providerGet[1]!);
      const cfg = await loadCortexConfig(cfgPath);
      const entry = cfg.llm?.providers?.[id];
      sendJson(res, 200, {
        id,
        enabled: entry?.enabled === true,
        configured: Boolean(entry),
        config: entry?.config ?? {},
        secretsConfigured: listConfiguredSecrets(id),
      });
      return true;
    }

    const adapterSchedule = pathname.match(
      /^\/api\/config\/adapters\/([^/]+)\/schedule$/,
    );
    if (req.method === "POST" && adapterSchedule) {
      const id = decodeURIComponent(adapterSchedule[1]!);
      const body = (await readJsonBody(req)) as { schedule?: unknown } | null;
      const raw = body?.schedule;
      const schedule =
        typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      await patchAdapterSchedule(cfgPath, id, schedule);
      const reloaded = await tryReload(ctx.opts, ctx.logger);
      ctx.logger.info("api.config.schedule", { id, schedule, reloaded });
      sendJson(res, 200, { id, schedule, reloaded });
      return true;
    }

    const adapterToggle = pathname.match(
      /^\/api\/config\/adapters\/([^/]+)\/toggle$/,
    );
    if (req.method === "POST" && adapterToggle) {
      const id = decodeURIComponent(adapterToggle[1]!);
      const result = await toggleConfigEntry(cfgPath, ["adapters", id]);
      const reloaded = await tryReload(ctx.opts, ctx.logger);
      ctx.logger.info("api.config.toggle", {
        kind: "adapter",
        id,
        enabled: result.enabled,
        reloaded,
      });
      sendJson(res, 200, { ...result, reloaded });
      return true;
    }
    const providerToggle = pathname.match(
      /^\/api\/config\/providers\/([^/]+)\/toggle$/,
    );
    if (req.method === "POST" && providerToggle) {
      const id = decodeURIComponent(providerToggle[1]!);
      const result = await toggleConfigEntry(cfgPath, [
        "llm",
        "providers",
        id,
      ]);
      const reloaded = await tryReload(ctx.opts, ctx.logger);
      ctx.logger.info("api.config.toggle", {
        kind: "provider",
        id,
        enabled: result.enabled,
        reloaded,
      });
      sendJson(res, 200, { ...result, reloaded });
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    ctx.logger.warn("api.config.failed", {
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

/**
 * Report which of a wizard's declared secrets are already set in the
 * process env. Returns bare env-var names, never values — the API
 * never leaks secret material back to the browser.
 */
function listConfiguredSecrets(wizardId: string): string[] {
  const wizard = findWizard(wizardId);
  if (!wizard) return [];
  const declared = wizard.secrets ?? [];
  return declared
    .filter((s) => {
      const v = process.env[s.envVar];
      return typeof v === "string" && v.length > 0;
    })
    .map((s) => s.envVar);
}

/**
 * Patch just the `schedule` field on an adapter entry. Writes to the
 * `.local.yaml` overlay when one exists — matches the loader's read
 * precedence so toggles actually take effect.
 */
async function patchAdapterSchedule(
  cfgPath: string,
  id: string,
  schedule: string | null,
): Promise<void> {
  const effectivePath = await resolveLocalFirst(cfgPath);
  const raw = await readFile(effectivePath, "utf8");
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const adapters = parsed.adapters;
  if (!adapters || typeof adapters !== "object") {
    throw new Error("cortex.yaml has no adapters block");
  }
  const entry = (adapters as Record<string, unknown>)[id];
  if (!entry || typeof entry !== "object") {
    throw new Error(
      `adapter '${id}' isn't configured yet — run its wizard first`,
    );
  }
  const typed = entry as Record<string, unknown>;
  if (schedule === null) {
    delete typed.schedule;
  } else {
    typed.schedule = schedule;
  }
  await writeFile(effectivePath, stringifyYaml(parsed), "utf8");
}

/**
 * Flip `enabled` on an arbitrary-depth config path without re-running
 * the wizard. Throws if the entry doesn't exist — callers must create
 * it first via POST /api/wizards/:id.
 */
async function toggleConfigEntry(
  cfgPath: string,
  keyPath: readonly string[],
): Promise<{ enabled: boolean }> {
  const effectivePath = await resolveLocalFirst(cfgPath);
  const raw = await readFile(effectivePath, "utf8");
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  let cursor: Record<string, unknown> = parsed;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const seg = keyPath[i]!;
    const next = cursor[seg];
    if (!next || typeof next !== "object") {
      throw new Error(`config path ${keyPath.join(".")} not found`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leafKey = keyPath[keyPath.length - 1]!;
  const entry = cursor[leafKey];
  if (!entry || typeof entry !== "object") {
    throw new Error(
      `${keyPath.join(".")} isn't configured yet — run its wizard first.`,
    );
  }
  const typedEntry = entry as Record<string, unknown>;
  const nextEnabled = typedEntry.enabled !== true;
  typedEntry.enabled = nextEnabled;
  await writeFile(effectivePath, stringifyYaml(parsed), "utf8");
  return { enabled: nextEnabled };
}
