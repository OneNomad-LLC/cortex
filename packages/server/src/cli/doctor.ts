import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  defaultTokenPath,
  readGoogleToken,
} from "@cortex/google-auth";
import type { Logger } from "@cortex/core";
import { createPgPool } from "@cortex/memory-pgvector";
import {
  resolveLocalFirst,
  type CortexConfig,
} from "../config.js";
import { createEngramClient } from "../clients/engram.js";
import { resolveConfigPath } from "./config-path.js";
import { getActiveWorkspace } from "./workspace/manager.js";

/**
 * `cortex doctor` — pre-flight diagnostic. Runs mechanical checks without
 * booting the server so operators can verify a fresh install or post-edit
 * state. Differs from:
 *   - `cortex status` — reads the RUNNING daemon's heartbeat
 *   - `cortex smoke`  — live LLM probe; requires providers already booted
 *
 * Everything here works against config + env + filesystem only. Never
 * throws — each check renders its own line with a verdict so the user
 * sees the full picture, not the first failure.
 */

type Verdict = "ok" | "fail" | "warn" | "skip";

interface CheckResult {
  name: string;
  verdict: Verdict;
  detail?: string;
}

const ADAPTER_PACKAGE_TO_SECRETS: Record<string, readonly string[]> = {
  "@cortex/adapter-bitbucket": ["ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"],
  "@cortex/adapter-confluence": ["ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"],
  "@cortex/adapter-github": ["GITHUB_TOKEN"],
  "@cortex/adapter-gmail": [],
  "@cortex/adapter-google-calendar": [],
  "@cortex/adapter-google-drive": [],
  "@cortex/adapter-jira": ["ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"],
  "@cortex/adapter-linear": ["LINEAR_API_KEY"],
  "@cortex/adapter-loom": ["LOOM_API_KEY"],
  "@cortex/adapter-notion": ["NOTION_API_KEY"],
  "@cortex/adapter-obsidian": [],
  "@cortex/adapter-slack": ["SLACK_BOT_TOKEN"],
};

const PROVIDER_PACKAGE_TO_SECRETS: Record<string, readonly string[]> = {
  "@cortex/provider-ollama": [],
  "@cortex/provider-openrouter": ["OPENROUTER_API_KEY"],
};

const GOOGLE_ID_TO_SCOPE: Record<string, string> = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  "google-calendar": "https://www.googleapis.com/auth/calendar.readonly",
  "google-drive": "https://www.googleapis.com/auth/drive.readonly",
};

export async function runDoctor(args: readonly string[]): Promise<number> {
  const connect = args.includes("--connect");
  const results: CheckResult[] = [];

  const cfgPath = resolveConfigPath();

  // 1. Config file readable
  const resolvedCfg = await resolveLocalFirst(cfgPath);
  const cfgRaw = await tryRead(resolvedCfg);
  if (!cfgRaw) {
    results.push({
      name: "config file",
      verdict: "fail",
      detail: `not readable: ${resolvedCfg}`,
    });
    await renderAndReturn(results, resolvedCfg);
    return 1;
  }
  results.push({
    name: "config file",
    verdict: "ok",
    detail: path.basename(resolvedCfg),
  });

  // 2. Env expansion — gather references WITHOUT throwing on missing
  const { missing: envMissing, refs: envRefs } = collectEnvRefs(cfgRaw);
  if (envMissing.length === 0) {
    results.push({
      name: "env var references",
      verdict: "ok",
      detail: `${envRefs.size} referenced, all set`,
    });
  } else {
    results.push({
      name: "env var references",
      verdict: "fail",
      detail: `unset: ${envMissing.join(", ")}`,
    });
  }

  // 3. Parse config. If expansion was incomplete, substitute empty strings
  //    so YAML still parses — we already reported the missing vars above.
  let cfg: CortexConfig | undefined;
  try {
    const substituted = cfgRaw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) =>
      process.env[name] ?? "",
    );
    cfg = parseYaml(substituted) as CortexConfig;
  } catch (err) {
    results.push({
      name: "config parse",
      verdict: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
    await renderAndReturn(results, resolvedCfg);
    return 1;
  }
  results.push({ name: "config parse", verdict: "ok" });

  // 4. Enabled adapters — check secrets individually
  const enabledAdapters = Object.entries(cfg?.adapters ?? {})
    .filter(([_, entry]) => entry && (entry as { enabled?: boolean }).enabled);
  if (enabledAdapters.length === 0) {
    results.push({
      name: "enabled adapters",
      verdict: "warn",
      detail: "none enabled — Cortex won't ingest anything",
    });
  } else {
    for (const [id, raw] of enabledAdapters) {
      const entry = raw as { package?: string };
      const required = entry.package
        ? ADAPTER_PACKAGE_TO_SECRETS[entry.package] ?? []
        : [];
      const missing = required.filter((n) => !process.env[n]);
      results.push(
        missing.length === 0
          ? { name: `adapter: ${id}`, verdict: "ok", detail: entry.package ?? "" }
          : {
              name: `adapter: ${id}`,
              verdict: "fail",
              detail: `missing secrets: ${missing.join(", ")}`,
            },
      );
    }
  }

  // 5. Enabled LLM providers
  const providers =
    (cfg?.llm as { providers?: Record<string, unknown> } | undefined)
      ?.providers ?? {};
  const enabledProviders = Object.entries(providers).filter(
    ([_, entry]) => entry && (entry as { enabled?: boolean }).enabled,
  );
  if (enabledProviders.length === 0) {
    results.push({
      name: "enabled llm providers",
      verdict: "fail",
      detail: "no providers enabled — pipelines can't run",
    });
  } else {
    for (const [id, raw] of enabledProviders) {
      const entry = raw as { package?: string };
      const required = entry.package
        ? PROVIDER_PACKAGE_TO_SECRETS[entry.package] ?? []
        : [];
      const missing = required.filter((n) => !process.env[n]);
      results.push(
        missing.length === 0
          ? { name: `provider: ${id}`, verdict: "ok", detail: entry.package ?? "" }
          : {
              name: `provider: ${id}`,
              verdict: "fail",
              detail: `missing secrets: ${missing.join(", ")}`,
            },
      );
    }
  }

  // 6. Google token — only check if any google-* adapter is enabled
  const googleEnabled = enabledAdapters
    .map(([id]) => id)
    .filter((id) => id in GOOGLE_ID_TO_SCOPE);
  if (googleEnabled.length > 0) {
    const tokenPath = defaultTokenPath();
    try {
      const token = await readGoogleToken(tokenPath);
      const needed = googleEnabled.map((id) => GOOGLE_ID_TO_SCOPE[id]!);
      const missingScopes = needed.filter((s) => !token.scopes.includes(s));
      if (missingScopes.length === 0) {
        results.push({
          name: "google oauth token",
          verdict: "ok",
          detail: `${token.scopes.length} scope(s) at ${path.basename(tokenPath)}`,
        });
      } else {
        results.push({
          name: "google oauth token",
          verdict: "fail",
          detail: `missing scopes: ${missingScopes.join(", ")} — rerun cortex google-login`,
        });
      }
    } catch {
      results.push({
        name: "google oauth token",
        verdict: "fail",
        detail: `not found at ${tokenPath} — run cortex google-login`,
      });
    }
  } else {
    results.push({
      name: "google oauth token",
      verdict: "skip",
      detail: "no Google adapters enabled",
    });
  }

  // 7. Memory backend — if pgvector is the fallback, POSTGRES_URL must resolve
  const memory = (cfg?.memory ?? {}) as {
    fallback?: string;
    pgvector?: { connectionString?: string };
  };
  if (memory.fallback === "pgvector") {
    const dsn = memory.pgvector?.connectionString;
    if (!dsn || dsn.includes("${")) {
      results.push({
        name: "memory fallback (pgvector)",
        verdict: "fail",
        detail: "POSTGRES_URL is unset or still templated",
      });
    } else {
      results.push({
        name: "memory fallback (pgvector)",
        verdict: "ok",
        detail: "DSN resolved (connection not tested — use --connect to probe)",
      });
    }
  } else {
    results.push({
      name: "memory fallback",
      verdict: "skip",
      detail: "no pgvector fallback configured",
    });
  }

  // 8. Projects taxonomy — optional but common point of confusion
  const projectsPath = path.resolve(path.dirname(resolvedCfg), "projects.yaml");
  const resolvedProjects = await resolveLocalFirst(projectsPath);
  const projectsRaw = await tryRead(resolvedProjects);
  if (!projectsRaw) {
    results.push({
      name: "projects taxonomy",
      verdict: "warn",
      detail: "no projects.yaml — run `cortex add projects`",
    });
  } else {
    try {
      const doc = parseYaml(projectsRaw) as { projects?: unknown[] };
      const count = Array.isArray(doc.projects) ? doc.projects.length : 0;
      results.push({
        name: "projects taxonomy",
        verdict: count > 0 ? "ok" : "warn",
        detail:
          count === 0
            ? "0 projects — run `cortex add projects`"
            : `${count} project${count === 1 ? "" : "s"} defined`,
      });
    } catch (err) {
      results.push({
        name: "projects taxonomy",
        verdict: "fail",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 9. Dashboard API posture — warn if enabled without a localhost bind.
  const api = (cfg?.api ?? {}) as { enabled?: boolean; host?: string; port?: number };
  if (api.enabled) {
    const host = api.host ?? "127.0.0.1";
    const localBinds = ["127.0.0.1", "localhost", "::1"];
    if (localBinds.includes(host)) {
      results.push({
        name: "dashboard api",
        verdict: "ok",
        detail: `enabled on ${host}:${api.port ?? 4141}`,
      });
    } else {
      results.push({
        name: "dashboard api",
        verdict: "warn",
        detail: `bound to ${host} — reachable beyond localhost; only safe over Tailscale`,
      });
    }
  } else {
    results.push({
      name: "dashboard api",
      verdict: "skip",
      detail: "not enabled",
    });
  }

  // 10. Live probes (opt-in: `cortex doctor --connect`). The checks above are
  //    mechanical; --connect actually talks to Engram and Postgres.
  if (connect) {
    const memCfg = (cfg?.memory ?? {}) as {
      primary?: string;
      fallback?: string;
      pgvector?: { connectionString?: string };
      engram?: { command?: string; args?: string[]; env?: Record<string, string> };
    };
    const primary = memCfg.primary ?? "engram";
    const fallback = memCfg.fallback;
    const usesEngram = primary === "engram" || fallback === "engram";
    const usesPgvector = primary === "pgvector" || fallback === "pgvector";

    if (usesEngram) {
      results.push(await probeEngram(memCfg.engram ?? {}));
    } else {
      results.push({
        name: "engram live probe",
        verdict: "skip",
        detail: "engram not configured as primary or fallback",
      });
    }

    if (usesPgvector) {
      const dsn = memCfg.pgvector?.connectionString;
      if (!dsn || dsn.includes("${")) {
        results.push({
          name: "pgvector live probe",
          verdict: "skip",
          detail: "DSN unresolved — see earlier check",
        });
      } else {
        results.push(await probePgvector(dsn));
      }
    } else {
      results.push({
        name: "pgvector live probe",
        verdict: "skip",
        detail: "pgvector not configured as primary or fallback",
      });
    }
  }

  return renderAndReturn(results, resolvedCfg);
}

/**
 * Spawn the Engram MCP subprocess, call `memory_stats`, shut it down.
 * Wrapped in a 15s budget because cold starts on Windows (spawn + import
 * graph + LanceDB open) can take several seconds; anything longer than
 * that is genuinely broken, not slow.
 */
async function probeEngram(
  engram: { command?: string; args?: string[]; env?: Record<string, string> },
): Promise<CheckResult> {
  const logger = silentLogger();
  const name = "engram live probe";
  const started = Date.now();

  try {
    const client = await withTimeout(
      createEngramClient({
        logger,
        ...(engram.command ? { command: engram.command } : {}),
        ...(engram.args && engram.args.length > 0 ? { args: engram.args } : {}),
        ...(engram.env && Object.keys(engram.env).length > 0
          ? { env: engram.env }
          : {}),
      }),
      15_000,
      "engram spawn/connect",
    );

    try {
      const health = await withTimeout(client.healthCheck(), 10_000, "engram healthCheck");
      const ms = Date.now() - started;
      if (health.healthy) {
        return {
          name,
          verdict: "ok",
          detail: `round-trip ${ms}ms via memory_stats`,
        };
      }
      return {
        name,
        verdict: "fail",
        detail: health.message || "healthcheck returned unhealthy",
      };
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /ENOENT|not found|spawn/i.test(msg)
      ? " — is @onenomad/engram-memory installed globally?"
      : "";
    return { name, verdict: "fail", detail: `${msg}${hint}` };
  }
}

/**
 * Open a pg Pool against the configured DSN and run `SELECT 1`. Keeps the
 * connect + query budget under 5s so a wrong DSN doesn't hang doctor.
 */
async function probePgvector(dsn: string): Promise<CheckResult> {
  const name = "pgvector live probe";
  const started = Date.now();
  const pool = createPgPool({
    connectionString: dsn,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await withTimeout(
      pool.query<{ ok: number }>("SELECT 1 AS ok"),
      5_000,
      "pgvector SELECT 1",
    );
    const ms = Date.now() - started;
    return { name, verdict: "ok", detail: `SELECT 1 round-trip ${ms}ms` };
  } catch (err) {
    return {
      name,
      verdict: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await pool.end?.().catch(() => undefined);
  }
}

function silentLogger(): Logger {
  const noop = (): void => undefined;
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tryRead(p: string): Promise<string | undefined> {
  try {
    await stat(p);
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

export function collectEnvRefs(cfgRaw: string): {
  refs: Set<string>;
  missing: string[];
} {
  const refs = new Set<string>();
  const lines = cfgRaw.split(/\r?\n/);
  for (const line of lines) {
    // Skip YAML comments — commented-out blocks shouldn't require env vars.
    if (/^\s*#/.test(line)) continue;
    const matches = line.matchAll(/\$\{([A-Z0-9_]+)\}/g);
    for (const m of matches) refs.add(m[1]!);
  }
  const missing = [...refs].filter(
    (name) => !process.env[name] || process.env[name] === "",
  );
  return { refs, missing };
}

async function renderAndReturn(
  results: CheckResult[],
  cfgPath: string,
): Promise<number> {
  process.stdout.write(`\ncortex doctor\n=============\n`);
  const active = await getActiveWorkspace().catch(() => undefined);
  if (active) {
    process.stdout.write(`workspace: ${active.slug}\n`);
  } else {
    process.stdout.write(`workspace: (none — using legacy config resolution)\n`);
  }
  process.stdout.write(`config:    ${cfgPath}\n\n`);
  const width = Math.max(...results.map((r) => r.name.length), 20);
  for (const r of results) {
    const tag = tagFor(r.verdict);
    const name = r.name.padEnd(width);
    process.stdout.write(
      `${tag}  ${name}${r.detail ? `  ${r.detail}` : ""}\n`,
    );
  }
  const failed = results.filter((r) => r.verdict === "fail").length;
  const warned = results.filter((r) => r.verdict === "warn").length;
  process.stdout.write(
    `\n${results.length} checks: ${results.length - failed - warned} ok, ${warned} warn, ${failed} fail.\n`,
  );
  return failed > 0 ? 1 : 0;
}

function tagFor(v: Verdict): string {
  switch (v) {
    case "ok":
      return "[ ok ]";
    case "fail":
      return "[FAIL]";
    case "warn":
      return "[warn]";
    case "skip":
      return "[skip]";
  }
}
