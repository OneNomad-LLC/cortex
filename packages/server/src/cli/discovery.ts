import path from "node:path";
import type {
  AdapterContext,
  EngramAccess,
  Logger,
  LLMAccess,
  ProjectCandidate,
  SourceAdapter,
} from "@cortex/core";
import { loadCortexConfig, type CortexConfig } from "../config.js";
import { factoryByWizardId } from "../registry/adapters.js";
import { loadTaxonomy } from "../taxonomy.js";

/**
 * Runtime discovery services shared between the projects wizard and
 * adapter post-install hooks. Builds an adapter registry with stub
 * Engram/LLM — discovery only needs authentication and HTTP, not the
 * full daemon — then calls `discoverProjects` on each target adapter.
 */

export interface DiscoveredCandidate extends ProjectCandidate {
  sources?: Record<string, unknown>;
}

export interface DiscoveryOptions {
  cfg: CortexConfig;
  repoRoot: string;
  logger: Logger;
  /** Limit discovery to these adapter ids. Omit to scan every enabled adapter. */
  adapterIds?: readonly string[];
}

export interface DiscoveryResult {
  candidates: DiscoveredCandidate[];
  /** Per-adapter outcome so callers can render a summary. */
  perAdapter: Array<{
    adapterId: string;
    status: "ok" | "no-discovery" | "failed" | "not-enabled";
    count?: number;
    error?: string;
  }>;
}

export async function discoverProjectCandidates(
  opts: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const taxonomy = await loadTaxonomy({
    projectsPath: path.join(opts.repoRoot, "config", "projects.yaml"),
    peoplePath: path.join(opts.repoRoot, "config", "people.yaml"),
  });

  const stubLlm: LLMAccess = {
    raw: null,
    complete: async () => "",
  };
  const stubEngram: EngramAccess = {
    ingest: async () => ({ id: "" }),
    healthCheck: async () => ({ healthy: true, message: "wizard-stub" }),
  };
  const abortController = new AbortController();

  const { buildAdapterRegistry } = await import("../registry/adapters.js");
  const registry = await buildAdapterRegistry({
    cfg: opts.cfg,
    env: process.env,
    logger: opts.logger,
    buildContext: (adapterId, entryConfig, secrets): AdapterContext => ({
      logger: opts.logger.child({ adapter: adapterId }),
      taxonomy,
      llm: stubLlm,
      engram: stubEngram,
      config: entryConfig,
      secrets,
      signal: abortController.signal,
    }),
  });

  const enabledIds = Object.entries(opts.cfg.adapters)
    .filter(([, entry]) => entry.enabled)
    .map(([id]) => id);
  const targetIds = opts.adapterIds
    ? opts.adapterIds.filter((id) => enabledIds.includes(id))
    : enabledIds;

  const candidates: DiscoveredCandidate[] = [];
  const perAdapter: DiscoveryResult["perAdapter"] = [];

  for (const adapterId of targetIds) {
    const adapter = registry.adapters[adapterId] as SourceAdapter | undefined;
    if (!adapter) {
      perAdapter.push({ adapterId, status: "not-enabled" });
      continue;
    }
    if (typeof adapter.discoverProjects !== "function") {
      perAdapter.push({ adapterId, status: "no-discovery" });
      continue;
    }
    try {
      const found = await adapter.discoverProjects();
      for (const c of found) {
        candidates.push({ ...c, sourceAdapter: adapterId });
      }
      perAdapter.push({ adapterId, status: "ok", count: found.length });
    } catch (err) {
      perAdapter.push({
        adapterId,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await registry.shutdown().catch(() => undefined);
  return { candidates: dedupeBySlug(candidates), perAdapter };
}

/** Merges candidates sharing a slug into one entry — exported for tests. */
export function dedupeBySlug(
  raw: readonly DiscoveredCandidate[],
): DiscoveredCandidate[] {
  const bySlug = new Map<string, DiscoveredCandidate>();
  for (const c of raw) {
    const existing = bySlug.get(c.slug);
    if (!existing) {
      bySlug.set(c.slug, { ...c });
      continue;
    }
    existing.sources = {
      ...(existing.sources ?? existing.sourceHints ?? {}),
      ...(c.sources ?? c.sourceHints ?? {}),
    };
  }
  return Array.from(bySlug.values()).map((c) => {
    const merged = c.sources ?? c.sourceHints;
    const next: DiscoveredCandidate = { ...c };
    if (merged && Object.keys(merged).length > 0) {
      next.sources = merged;
    } else {
      delete next.sources;
    }
    return next;
  });
}

/**
 * Load `cortex.yaml` fresh for discovery — the post-install hook needs
 * the newly-merged adapter config, which only lands after
 * `applyWizardResult` writes to `cortex.local.yaml`.
 */
export async function loadCurrentConfig(
  configPath: string,
): Promise<CortexConfig | undefined> {
  try {
    return await loadCortexConfig(configPath);
  } catch {
    return undefined;
  }
}

/**
 * Pre-install discovery: run `discoverProjects` on an adapter BEFORE
 * it's been merged into cortex.yaml. Used by the dashboard setup flow
 * so the user connects auth, then sees a multi-select of available
 * resources without first having to save a partial config.
 *
 * The adapter is instantiated with the provided config (whatever the
 * wizard has collected so far — for GitHub that's often empty, since
 * the token lives in the device-flow file). Adapters that validate
 * non-auth fields in init may reject this call; we surface that as
 * a "failed" status the UI can display.
 */
export async function discoverForWizard(args: {
  wizardId: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  logger: Logger;
  repoRoot: string;
}): Promise<{
  candidates: DiscoveredCandidate[];
  status: "ok" | "no-discovery" | "failed";
  error?: string;
}> {
  const factory = factoryByWizardId(args.wizardId);
  if (!factory) {
    return {
      candidates: [],
      status: "failed",
      error: `no adapter registered for wizard '${args.wizardId}'`,
    };
  }

  const adapter = factory() as SourceAdapter;
  if (typeof adapter.discoverProjects !== "function") {
    return { candidates: [], status: "no-discovery" };
  }

  // Parse the caller's config through the adapter's schema so
  // defaults fill in. Don't hard-fail — some adapters' schemas
  // require fields that discovery doesn't actually need.
  let parsedConfig: Record<string, unknown>;
  try {
    parsedConfig = adapter.configSchema.parse(args.config) as Record<
      string,
      unknown
    >;
  } catch {
    parsedConfig = { ...args.config };
  }

  const taxonomy = await loadTaxonomy({
    projectsPath: path.join(args.repoRoot, "config", "projects.yaml"),
    peoplePath: path.join(args.repoRoot, "config", "people.yaml"),
  });

  const stubLlm: LLMAccess = { raw: null, complete: async () => "" };
  const stubEngram: EngramAccess = {
    ingest: async () => ({ id: "" }),
    healthCheck: async () => ({ healthy: true, message: "wizard-stub" }),
  };
  const abortController = new AbortController();

  try {
    await adapter.init({
      logger: args.logger.child({ adapter: args.wizardId }),
      taxonomy,
      llm: stubLlm,
      engram: stubEngram,
      config: parsedConfig,
      secrets: args.secrets,
      signal: abortController.signal,
    });
    const found = await adapter.discoverProjects();
    await adapter.shutdown().catch(() => undefined);
    const candidates: DiscoveredCandidate[] = found.map((c) => ({
      ...c,
      sourceAdapter: args.wizardId,
    }));
    return { candidates: dedupeBySlug(candidates), status: "ok" };
  } catch (err) {
    return {
      candidates: [],
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
