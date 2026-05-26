/**
 * Dashboard-scoped wizard endpoints. These are the read/run surface the
 * `/_dashboard` SPA consumes when an operator clicks "Add adapter" or
 * "Add provider" — they mirror the older `/api/wizards/*` routes but live
 * under `/api/dashboard/*` so they sit behind `requireDashboardAuth`
 * (admin scope) instead of the broader API auth.
 *
 * Surface:
 *   GET  /api/dashboard/wizard/list?category=adapter|provider|memory|webhook
 *        → { modules: Array<{ id, kind, name, description?, version? }> }
 *   GET  /api/dashboard/wizard/spec/:moduleKind/:moduleId
 *        → full WizardModule spec (steps[], secrets[], etc.) — configSchema
 *          stripped because Zod isn't JSON-serializable and the dashboard
 *          doesn't need it (validation happens server-side in `run`).
 *   POST /api/dashboard/wizard/run  body: { moduleKind, moduleId, answers }
 *        → { ok: true, filesWritten, reloaded } on success
 *          { ok: false, errors: { [stepKey]: message } } on validation failure
 *
 * All admin-gated. CSRF on POST enforced by `requireDashboardAuth`.
 *
 * Why a parallel surface to `/api/wizards`?
 *   - The legacy `/api/wizards` is hit by the pyre-web embed via a
 *     gateway secret. The dashboard runs as a first-class browser app
 *     and needs cookie/bearer scoping with admin-only mutation. Putting
 *     it under the dashboard namespace keeps the gate consistent across
 *     every page the SPA loads.
 *   - The dashboard's request body uses a flat `{ answers }` shape that
 *     matches the wizard renderer's react-hook-form state, instead of
 *     the split `{ config, secrets }` the gateway path uses. The split
 *     happens server-side here from the wizard's declared secret list.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { readJsonBody, sendJson } from "../http.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import { findWizard, listWizards } from "../../cli/wizard-registry.js";
import { applyWizardResult } from "../../cli/config-mutation.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";
import { tryReload } from "../reload.js";
import type { WizardModule } from "@onenomad/przm-cortex-core";

type ModuleKind = WizardModule["category"];

const VALID_KINDS: ReadonlySet<ModuleKind> = new Set<ModuleKind>([
  "adapter",
  "provider",
  "memory",
  "toolkit",
  "webhook",
]);

function isModuleKind(value: string): value is ModuleKind {
  return VALID_KINDS.has(value as ModuleKind);
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;
  if (!pathname.startsWith("/api/dashboard/wizard")) return false;

  const gate = requireDashboardAuth(["admin"]);
  const resolved = await gate(req, res);
  if (!resolved) return true;

  try {
    if (req.method === "GET" && pathname === "/api/dashboard/wizard/list") {
      return handleList(req, res, ctx);
    }
    const specMatch = pathname.match(
      /^\/api\/dashboard\/wizard\/spec\/([^/]+)\/([^/]+)$/,
    );
    if (req.method === "GET" && specMatch) {
      return handleSpec(res, specMatch[1]!, specMatch[2]!);
    }
    if (req.method === "POST" && pathname === "/api/dashboard/wizard/run") {
      return handleRun(req, res, ctx);
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    ctx.logger.warn("api.dashboard_wizard.failed", {
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

function handleList(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const categoryParam = ctx.url.searchParams.get("category");
  let filter: ModuleKind | undefined;
  if (categoryParam !== null) {
    if (!isModuleKind(categoryParam)) {
      sendJson(res, 400, { error: `unknown category '${categoryParam}'` });
      return Promise.resolve(true);
    }
    filter = categoryParam;
  }

  const modules = listWizards()
    .filter((w) => (filter ? w.category === filter : true))
    .map((w) => ({
      id: w.id,
      kind: w.category,
      name: w.name,
      description: w.description,
    }));

  sendJson(res, 200, { modules });
  return Promise.resolve(true);
}

function handleSpec(
  res: ServerResponse,
  moduleKind: string,
  moduleId: string,
): Promise<boolean> {
  if (!isModuleKind(moduleKind)) {
    sendJson(res, 400, { error: `unknown module kind '${moduleKind}'` });
    return Promise.resolve(true);
  }
  const wizard = findWizard(moduleId);
  if (!wizard || wizard.category !== moduleKind) {
    sendJson(res, 404, {
      error: `wizard '${moduleKind}/${moduleId}' not found`,
    });
    return Promise.resolve(true);
  }

  // configSchema is a Zod type — not JSON-serializable. Pattern fields on
  // text steps are RegExp; serialize the source so the client can run a
  // mirror check before submit (the server still re-validates).
  sendJson(res, 200, {
    id: wizard.id,
    kind: wizard.category,
    name: wizard.name,
    description: wizard.description,
    steps: wizard.steps.map(serializeStep),
    secrets: (wizard.secrets ?? []).map((s) => ({ ...s })),
  });
  return Promise.resolve(true);
}

function serializeStep(step: WizardModule["steps"][number]): unknown {
  // Strip RegExp instances so JSON.stringify doesn't drop them silently —
  // we surface the source string + flags instead so the renderer can
  // reconstitute its own RegExp client-side.
  const base = { ...(step as unknown as Record<string, unknown>) };
  if ("pattern" in step && step.pattern instanceof RegExp) {
    base.pattern = { source: step.pattern.source, flags: step.pattern.flags };
  }
  if (step.type === "list") {
    if (step.itemPattern instanceof RegExp) {
      base.itemPattern = {
        source: step.itemPattern.source,
        flags: step.itemPattern.flags,
      };
    }
    if (step.splitter instanceof RegExp) {
      base.splitter = {
        source: step.splitter.source,
        flags: step.splitter.flags,
      };
    }
  }
  if (step.type === "repeat-per") {
    base.sub = step.sub.map(serializeStep);
  }
  return base;
}

async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const body = (await readJsonBody(req)) as {
    moduleKind?: string;
    moduleId?: string;
    answers?: Record<string, unknown>;
  };

  if (typeof body.moduleKind !== "string" || !isModuleKind(body.moduleKind)) {
    sendJson(res, 400, { error: "moduleKind is required" });
    return true;
  }
  if (typeof body.moduleId !== "string" || body.moduleId.length === 0) {
    sendJson(res, 400, { error: "moduleId is required" });
    return true;
  }
  const wizard = findWizard(body.moduleId);
  if (!wizard || wizard.category !== body.moduleKind) {
    sendJson(res, 404, {
      error: `wizard '${body.moduleKind}/${body.moduleId}' not found`,
    });
    return true;
  }

  const answers = body.answers ?? {};

  // Split answers into config (step keys) + secrets (declared env var keys).
  const configInput: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  const declaredSecrets = new Set((wizard.secrets ?? []).map((s) => s.envVar));
  for (const [k, v] of Object.entries(answers)) {
    if (declaredSecrets.has(k)) {
      // Skip secrets that were left at the "__REDACTED__" sentinel —
      // the renderer uses that to mean "don't replace, keep what's on
      // disk." Empty strings also count as no-op so a wizard re-run
      // doesn't clobber a saved secret.
      if (typeof v !== "string" || v === "__REDACTED__" || v.length === 0) {
        continue;
      }
      secrets[k] = v;
      continue;
    }
    configInput[k] = v;
  }

  const parsed = wizard.configSchema.safeParse(configInput);
  if (!parsed.success) {
    // Surface validation errors keyed by step path so the renderer can
    // highlight the offending field. Falls back to the joined path when
    // the issue's path is empty (top-level refine).
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key =
        issue.path.length > 0
          ? issue.path.map(String).join(".")
          : "__root__";
      errors[key] = issue.message;
    }
    sendJson(res, 400, { ok: false, errors });
    return true;
  }

  const active = await getActiveWorkspace();
  if (!active) {
    sendJson(res, 400, {
      ok: false,
      errors: { __root__: "no active workspace — switch one in first" },
    });
    return true;
  }

  const derivedTaxonomy = wizard.derivedTaxonomy?.(
    configInput as Record<string, unknown>,
  );

  const applied = await applyWizardResult(
    { repoRoot: active.path },
    {
      moduleId: wizard.id,
      category: wizard.category,
      config: parsed.data,
      secrets,
      ...(derivedTaxonomy ? { derivedTaxonomy } : {}),
    },
  );

  // Push secrets into the live process env so the upcoming hot-reload
  // sees them without a container restart.
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === "string" && v.length > 0) process.env[k] = v;
  }
  const reloaded = await tryReload(ctx.opts, ctx.logger);

  sendJson(res, 200, {
    ok: true,
    filesWritten: applied.filesWritten,
    reloaded,
    restartRequired: !reloaded,
  });
  return true;
}
