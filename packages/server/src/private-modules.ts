import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "@onenomad/przm-cortex-core";
import type { AnyMcpTool } from "./mcp/tool.js";

/**
 * Loader for private/personal Cortex modules.
 *
 * A private module is a directory with a `dist/index.js` that
 * exports an `mcpTools` array — same shape as the built-in tools.
 * Cortex loads each configured path at server startup and merges
 * the returned tools into the main MCP tool surface, so Claude
 * sees them alongside everything else with no additional MCP
 * server configuration needed.
 *
 * This is the `packages/adapter-github`-style "module" idea, but
 * for code living outside the public Cortex repo — personal stuff
 * (job profile, private playbooks, workflow helpers). Keeps the
 * public codebase pristine while letting Cortex still host them.
 *
 * Config shape:
 *   ```yaml
 *   privateModules:
 *     - /root/.cortex-private/packages/cortex-job-profile
 *   ```
 *
 * Paths must point to module root directories; the loader resolves
 * `<path>/dist/index.js` as the import target.
 */

export interface PrivateModule {
  /** Source directory this module was loaded from. */
  path: string;
  /** Package name from its package.json, if discoverable. */
  name?: string;
  /** Tools the module exports. */
  tools: AnyMcpTool[];
}

export async function loadPrivateModules(
  paths: readonly string[],
  logger: Logger,
): Promise<PrivateModule[]> {
  const out: PrivateModule[] = [];
  for (const raw of paths) {
    const modulePath = raw.trim();
    if (!modulePath) continue;
    try {
      const resolved = await loadOne(modulePath, logger);
      if (resolved) out.push(resolved);
    } catch (err) {
      logger.warn("private_modules.load_failed", {
        path: modulePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

async function loadOne(
  modulePath: string,
  logger: Logger,
): Promise<PrivateModule | undefined> {
  const entry = path.join(modulePath, "dist", "index.js");
  if (!existsSync(entry)) {
    logger.warn("private_modules.no_dist", {
      path: modulePath,
      hint:
        "Run `pnpm -r build` inside the private repo — the loader expects a compiled dist/index.js.",
    });
    return undefined;
  }

  // Dynamic import from an absolute file path needs a file:// URL on
  // Windows; pathToFileURL handles cross-platform.
  const mod = (await import(pathToFileURL(entry).href)) as {
    mcpTools?: unknown;
  };
  const tools = mod.mcpTools;
  if (!Array.isArray(tools)) {
    logger.warn("private_modules.no_tools_export", {
      path: modulePath,
      hint:
        "Module must export `mcpTools` as an array. Check the module's src/index.ts.",
    });
    return undefined;
  }

  const valid: AnyMcpTool[] = [];
  for (const t of tools) {
    if (looksLikeMcpTool(t)) valid.push(t);
    else {
      logger.warn("private_modules.bad_tool_shape", {
        path: modulePath,
        sample: typeof t === "object" ? Object.keys(t as object) : typeof t,
      });
    }
  }

  logger.info("private_modules.loaded", {
    path: modulePath,
    tools: valid.map((t) => t.name),
  });

  return {
    path: modulePath,
    tools: valid,
  };
}

function looksLikeMcpTool(v: unknown): v is AnyMcpTool {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    typeof o.description === "string" &&
    o.inputSchema !== undefined &&
    typeof o.handler === "function"
  );
}
