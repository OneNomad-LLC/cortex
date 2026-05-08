import { loadCortexConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { buildLLMRouter } from "../registry/providers.js";
import { createMemoryClient } from "../clients/memory.js";
import { resolveConfigPath } from "./config-path.js";
import type { EngramClient, EngramMemory } from "../clients/engram.js";

/**
 * `cortex backfill workspace --slug <slug>` — audit Phase 1b workspace
 * filter coverage.
 *
 * Phase 1b's `_workspace-filter.ts` excludes memories whose
 * `metadata.workspace` doesn't match the per-request workspace slug,
 * including memories with NO workspace stamp at all (legacy ingests
 * pre-session-scoping). Without a way to stamp those rows, they're
 * permanently invisible to workspace-scoped widgets.
 *
 * This CLI quantifies that population: counts how many memories lack
 * a workspace stamp and would benefit from a backfill, samples a few
 * for spot-check, and reports.
 *
 * Why it doesn't actually mutate yet: Engram exposes no
 * memory_update / memory_add_tag tool. The CLI's write path is gated
 * on an engram-side additive API (per north-star: engram changes are
 * generic non-breaking additions, not Cortex-specific hooks). When
 * that ships, this command flips from audit-only to actually-stamp
 * with the same flag surface — `--dry-run` already false-by-default.
 *
 * Until then: `--dry-run` is the only behavior, even when omitted.
 * The audit output is enough to plan the cutover (decide whether
 * legacy memories matter for your workflow before pushing for the
 * engram tool).
 */
export interface BackfillCliOptions {
  slug: string;
  dryRun: boolean;
  limit: number;
  searchQuery?: string;
}

export function parseBackfillArgs(
  argv: readonly string[],
): BackfillCliOptions | { error: string } {
  if (argv.length === 0 || argv[0] !== "workspace") {
    return {
      error:
        "cortex backfill: only 'workspace' subcommand exists. Try `cortex backfill workspace --slug <slug>`",
    };
  }
  const opts: BackfillCliOptions = { slug: "", dryRun: false, limit: 1000 };
  for (const flag of argv.slice(1)) {
    if (flag === "--dry-run") opts.dryRun = true;
    else if (flag.startsWith("--slug=")) opts.slug = flag.slice("--slug=".length);
    else if (flag.startsWith("--limit=")) {
      const n = Number.parseInt(flag.slice("--limit=".length), 10);
      if (!Number.isFinite(n) || n <= 0) return { error: `invalid --limit value` };
      opts.limit = n;
    } else if (flag.startsWith("--query=")) {
      opts.searchQuery = flag.slice("--query=".length);
    } else {
      return { error: `unknown flag: ${flag}` };
    }
  }
  if (!opts.slug) return { error: "cortex backfill workspace: --slug=<slug> required" };
  return opts;
}

export interface BackfillReport {
  totalScanned: number;
  unstamped: number;
  alreadyStamped: { matchesSlug: number; differentSlug: number };
  sample: Array<{ id: string; preview: string; date?: string; project?: string }>;
}

/**
 * Pure logic — separated from runBackfillCli so tests can drive it
 * with a mock engram client without the cortex config / LLM router /
 * memory bootstrap dance.
 */
export async function buildBackfillReport(
  engram: Pick<EngramClient, "search">,
  opts: { slug: string; limit: number; query?: string },
): Promise<BackfillReport> {
  // Engram has no "metadata field is missing" filter, so we fetch a
  // wide net and filter client-side. The `query` is a lever for
  // narrowing the audit when the dataset is huge — defaults to "*"
  // (engram treats empty as match-all).
  const rows = await engram.search({
    query: opts.query ?? "*",
    limit: opts.limit,
  });

  let unstamped = 0;
  let matchesSlug = 0;
  let differentSlug = 0;
  const sample: BackfillReport["sample"] = [];

  for (const row of rows) {
    const tags = row.tags ?? [];
    const wsTag = tags.find((t) => t.startsWith("workspace:"));
    if (!wsTag) {
      unstamped += 1;
      if (sample.length < 5) {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const project = typeof meta.project === "string" ? meta.project : undefined;
        const date = typeof meta.date === "string" ? meta.date : row.createdAt;
        sample.push({
          id: row.id,
          preview: previewContent(row.content),
          ...(date ? { date } : {}),
          ...(project ? { project } : {}),
        });
      }
    } else if (wsTag.slice("workspace:".length) === opts.slug) {
      matchesSlug += 1;
    } else {
      differentSlug += 1;
    }
  }

  return {
    totalScanned: rows.length,
    unstamped,
    alreadyStamped: { matchesSlug, differentSlug },
    sample,
  };
}

function previewContent(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 120) return oneLine;
  return `${oneLine.slice(0, 117)}…`;
}

export async function runBackfillCli(argv: readonly string[]): Promise<number> {
  const parsed = parseBackfillArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  const logger = createLogger({ component: "backfill" });
  const configPath = resolveConfigPath();
  const cfg = await loadCortexConfig(configPath);

  // Memory bootstrap mirrors `cortex sync`: build LLM router (pgvector
  // backend uses it for embeddings during init) then memory client.
  const { router: llmRouter } = await buildLLMRouter({ cfg, env: process.env, logger });
  const memoryBoot = await createMemoryClient({
    memory: cfg.memory,
    ...(llmRouter ? { llmRouter } : {}),
    logger,
  });
  const engram = memoryBoot.client;

  try {
    const reportArgs: { slug: string; limit: number; query?: string } = {
      slug: parsed.slug,
      limit: parsed.limit,
    };
    if (parsed.searchQuery !== undefined) reportArgs.query = parsed.searchQuery;
    const report = await buildBackfillReport(engram, reportArgs);

    process.stdout.write(formatReport(report, parsed));

    // Engram has no memory_update tool today, so even a non-dry-run
    // invocation can only audit, not write. Surface this loud so
    // operators don't quietly assume the stamp happened.
    if (!parsed.dryRun) {
      process.stdout.write(
        "\nNote: backfill *write* path requires an engram-side `memory_add_tag` tool that doesn't exist yet — only the audit ran. " +
        "See PR description for the proposed engram API addition.\n",
      );
    }
    return 0;
  } finally {
    await engram.shutdown().catch(() => undefined);
  }
}

function formatReport(report: BackfillReport, opts: BackfillCliOptions): string {
  const lines: string[] = [];
  lines.push(`backfill workspace audit (slug=${opts.slug}, limit=${opts.limit}${opts.dryRun ? ", dry-run" : ""})`);
  lines.push(`  scanned:           ${report.totalScanned} memories`);
  lines.push(`  unstamped:         ${report.unstamped} (would be stamped with workspace:${opts.slug})`);
  lines.push(`  already this slug: ${report.alreadyStamped.matchesSlug}`);
  lines.push(`  different slug:    ${report.alreadyStamped.differentSlug} (would NOT be touched — they belong to other workspaces)`);
  if (report.sample.length > 0) {
    lines.push("");
    lines.push(`  sample of unstamped:`);
    for (const row of report.sample) {
      const meta = [row.date, row.project].filter(Boolean).join(" · ");
      lines.push(`    [${row.id}] ${meta ? `(${meta}) ` : ""}${row.preview}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
