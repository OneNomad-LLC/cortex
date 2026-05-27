import type { EngramAccess, HealthStatus, Logger } from "@onenomad/przm-cortex-core";
import {
  callJsonTool,
  connectMcpSubprocess,
  type McpSubprocess,
} from "./mcp-subprocess.js";

export interface EngramClientOptions {
  /** Bin name for the Engram MCP server. Default: "engram-memory". */
  command?: string;
  args?: string[];
  /** Extra env passed to the subprocess (e.g. ENGRAM_DATA_DIR overrides). */
  env?: Record<string, string>;
  logger: Logger;
}

export interface EngramSearchArgs {
  query: string;
  /** Cap on returned memories. */
  limit?: number;
  /** Project slug filter. Matched via a `project:<slug>` tag. */
  project?: string;
  /**
   * Cortex content type filter (meeting, decision, action_item, etc.).
   * Engram's native type enum is narrower (fact/preference/decision/
   * context/correction), so Cortex types are carried as a `cortex_type:X`
   * tag and matched via engram's tag filter.
   */
  type?: string;
  /** Source filter (loom, confluence, ...). Matched via `source:<x>` tag. */
  source?: string;
  /** ISO 8601 lower bound on the `date` field. (client-side filter) */
  sinceIso?: string;
  /** Domain to search within. Cortex uses "work". */
  domain?: string;
  /**
   * Workspace slug filter. Matches the `workspace:<slug>` tag stamped on
   * memories at ingest. When provided, results with a *different*
   * workspace are excluded; results WITHOUT a workspace tag (pre-session-
   * scoping ingests) still pass so legacy memories remain findable.
   */
  workspace?: string;
  /**
   * Maximum sensitivity level to include. Rows with higher sensitivity are
   * excluded. Omit (default) = no filter. Ordering: public < internal <
   * confidential < restricted.
   */
  maxSensitivity?: "public" | "internal" | "confidential" | "restricted";
  /**
   * Minimum trust level for strict exclusion. Omit to use the default soft
   * down-ranking of `experimental` and `external` rows. Ordering:
   * external < experimental < approved.
   */
  minTrust?: "external" | "experimental" | "approved";
}

export interface EngramMemory {
  id: string;
  content: string;
  score?: number;
  /**
   * Derived for backward compat with callers that read memory fields via
   * `metadata.X`. Populated from engram's flat response fields (tags,
   * source, type, domain, topic). Engram itself has no nested metadata
   * object — it returns a flat row — so this shape is assembled here.
   */
  metadata?: Record<string, unknown>;
  createdAt?: string;
  type?: string;
  tags?: string[];
}

export interface EngramClient extends EngramAccess {
  search(args: EngramSearchArgs): Promise<EngramMemory[]>;
  shutdown(): Promise<void>;
  /**
   * Optional cold-storage dump. Embedded PGlite backends implement
   * this; external Postgres backends omit it. Callers probe with
   * `typeof client.dumpDataDir === 'function'`. Returns a gzipped tar
   * Blob of the entire data directory — pyre-web's cold-storage
   * orchestrator uploads it as-is to object storage.
   */
  dumpDataDir?(): Promise<Blob>;
  /**
   * Wipe every memory row. Data-only — doesn't touch config, secrets,
   * or other tables. Used by the destructive 'clean slate' action in
   * pyre-web's Engram page danger zone.
   */
  wipeAll(): Promise<{ deleted: number }>;
  /**
   * Stream every memory row for data-portability exports. Async
   * iterator so callers can serialize JSONL straight to the response
   * without materializing the whole table.
   */
  exportAll(opts?: {
    includeEmbedding?: boolean;
    batchSize?: number;
  }): AsyncIterable<EngramExportRow>;
}

export interface EngramExportRow {
  id: string;
  sourceId?: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Workspace-scoped filter applied after Engram returns results. Engram
 * doesn't know about Cortex's `workspace` concept — so the filter runs
 * client-side here. Workspace is encoded as a `workspace:<slug>` tag at
 * ingest time. Memories WITHOUT any `workspace:*` tag pass through so
 * legacy (pre-session-scoping) ingests remain findable. Exported for
 * tests and re-use.
 */
export function filterByWorkspace(
  rows: EngramMemory[],
  workspace: string | undefined,
): EngramMemory[] {
  if (!workspace) return rows;
  return rows.filter((row) => {
    const tags = row.tags ?? [];
    const wsTag = tags.find((t) => t.startsWith("workspace:"));
    if (!wsTag) return true; // no workspace stamp = legacy, keep it
    return wsTag.slice("workspace:".length) === workspace;
  });
}

// `createEngramClient()` was removed in Cortex 0.3 when the runtime
// went standalone — memory is served in-process by the pgvector backend
// (see clients/memory.ts), not by an Engram MCP subprocess. The
// EngramClient type / EngramMemory / filterByWorkspace exports above
// are reused by clients/pgvector.ts so the rest of the codebase can
// keep speaking the same shape regardless of backend.

/**
 * Engram's native type enum is narrow. Cortex carries its richer type
 * vocabulary (action_item, meeting, brief, etc.) as a `cortex_type:X`
 * tag plus a mapped engram-native type so retrieval still benefits from
 * engram's type-aware ranking.
 */
function mapCortexTypeToEngram(cortexType: string | undefined): string | undefined {
  switch (cortexType) {
    case "decision":
      return "decision";
    case undefined:
    case "":
      return undefined;
    // Everything else lands as `context` — engram's closest catch-all —
    // with the real type preserved in tags. preference/fact/correction
    // aren't first-class Cortex types today but pass through cleanly.
    default:
      return "context";
  }
}

/**
 * Infer importance when the caller doesn't specify one. Pinned to the
 * type because action items and decisions load-bear daily work and
 * should survive consolidation longer than raw docs.
 */
function inferImportance(cortexType: string | undefined): number {
  switch (cortexType) {
    case "action_item":
      return 0.85;
    case "decision":
      return 0.9;
    case "brief":
    case "digest":
      return 0.8;
    case "meeting":
    case "conversation":
      return 0.7;
    default:
      return 0.6;
  }
}

/**
 * Build the tag list Cortex encodes onto every ingest. These are what
 * `my_action_items` and friends read back — since engram's native schema
 * doesn't carry project/owner/due/status/source_id natively, they ride
 * as structured tags.
 */
function buildCortexTags(
  metadata: Record<string, unknown>,
  extra: string[] = [],
): string[] {
  const tags: string[] = [];
  const push = (k: string, v: unknown): void => {
    if (typeof v === "string" && v.length > 0) tags.push(`${k}:${v}`);
  };

  push("cortex_type", metadata.type as string | undefined);
  const project = metadata.project;
  if (typeof project === "string") {
    push("project", project);
  } else if (Array.isArray(project)) {
    for (const p of project) if (typeof p === "string") push("project", p);
  }
  push("workspace", metadata.workspace as string | undefined);
  push("source", metadata.source as string | undefined);
  push("source_id", metadata.source_id as string | undefined);
  push("date", metadata.date as string | undefined);

  const existing = Array.isArray(metadata.tags) ? (metadata.tags as unknown[]) : [];
  for (const t of existing) if (typeof t === "string") tags.push(t);
  for (const t of extra) tags.push(t);

  return tags;
}

interface EngramIngestResponse {
  ingested?: number;
  duplicate?: boolean;
  similar?: Array<{ id: string; content: string; score: number }>;
  memory?: { id?: string };
}

/**
 * Wire an EngramClient on top of an already-connected McpSubprocess.
 * Exported so tests can inject a scripted subprocess (fake `client.callTool`)
 * without having to spawn the real engram binary.
 */
export function buildClient(sub: McpSubprocess, logger: Logger): EngramClient {
  let lastSuccessAt: number | undefined;

  return {
    async ingest(input) {
      // Engram's memory_ingest has a FLAT schema — content/type/tags/
      // domain/topic/source/importance — no nested metadata field. So we
      // flatten Cortex's richer metadata into engram's shape here. Cortex-
      // specific fields (project, workspace, owner, due, etc.) ride as
      // structured tags so they survive the round-trip.
      const md = (input.metadata ?? {}) as Record<string, unknown>;
      const cortexType = typeof md.type === "string" ? md.type : undefined;
      const engramType = mapCortexTypeToEngram(cortexType);
      const tags = buildCortexTags(md);
      const domain = typeof md.domain === "string" && md.domain.length > 0
        ? md.domain
        : "work";
      const topic = typeof md.project === "string"
        ? md.project
        : Array.isArray(md.project)
          ? ((md.project[0] as string | undefined) ?? "")
          : "";
      const importance = typeof md.confidence === "number"
        ? md.confidence
        : inferImportance(cortexType);

      // Structured types (action items, decisions, briefs) are often
      // refinements of broader context already stored — engram's 0.75
      // dedupe would swallow them. Skip dedupe for types the caller
      // owns the uniqueness of via source_id.
      const skipDedupe = cortexType !== undefined && cortexType !== "doc" && cortexType !== "code";

      const payload: Record<string, unknown> = {
        content: input.content,
        ...(engramType ? { type: engramType } : {}),
        ...(tags.length > 0 ? { tags: tags.join(",") } : {}),
        ...(domain ? { domain } : {}),
        ...(topic ? { topic } : {}),
        ...(typeof md.source_id === "string" ? { source: md.source_id } : {}),
        importance,
        ...(skipDedupe ? { skipDedupe: true } : {}),
      };

      // 5-minute timeout: CPU embeddings + LanceDB write on large files
      // can exceed the SDK's 60s default. Real deadlocks still surface,
      // just after a longer grace period.
      const res = await callJsonTool<EngramIngestResponse>(
        sub.client,
        "memory_ingest",
        payload,
        { timeoutMs: 300_000 },
      );
      lastSuccessAt = Date.now();

      // Engram returns { ingested: number, ... }. Zero means the write
      // was rejected — almost always a duplicate. Surface that loud
      // rather than letting ingest_content report fake success.
      const ingestedCount = typeof res?.ingested === "number" ? res.ingested : 0;
      if (ingestedCount === 0) {
        const reason = res?.duplicate
          ? `duplicate of ${res.similar?.[0]?.id ?? "existing memory"}`
          : "engram returned ingested=0 with no reason";
        throw new Error(`engram rejected ingest: ${reason}`);
      }

      return { id: res?.memory?.id ?? "" };
    },

    async search(args) {
      // Cortex types ride as `cortex_type:X` tags; translate `args.type`
      // into a tag filter against engram's new exact-tag-match support.
      const tag = args.type ? `cortex_type:${args.type}` : undefined;

      const payload: Record<string, unknown> = {
        query: args.query,
        maxResults: args.limit ?? 10,
        ...(args.domain ? { domain: args.domain } : { domain: "work" }),
        ...(tag ? { tag } : {}),
      };

      const res = await callJsonTool<{
        results?: Array<Record<string, unknown>>;
        memories?: EngramMemory[];
      } | EngramMemory[]>(sub.client, "memory_search", payload);
      lastSuccessAt = Date.now();

      const rawRows = Array.isArray(res)
        ? res
        : (res?.results ?? res?.memories ?? []);

      const normalized: EngramMemory[] = rawRows.map((row) => {
        const r = row as Record<string, unknown>;
        const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
        // Project engram's flat row into Cortex's EngramMemory shape.
        // `metadata` is assembled from tags + flat fields so callers
        // that read `mem.metadata.tags` / `mem.metadata.source` keep
        // working without a downstream refactor.
        return {
          id: typeof r.id === "string" ? r.id : "",
          content: typeof r.content === "string" ? r.content : "",
          ...(typeof r.score === "number" ? { score: r.score } : {}),
          ...(typeof r.type === "string" ? { type: r.type } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          metadata: {
            ...(tags.length > 0 ? { tags } : {}),
            ...(typeof r.source === "string" ? { source: r.source, source_id: r.source } : {}),
            ...(typeof r.domain === "string" ? { domain: r.domain } : {}),
            ...(typeof r.topic === "string" ? { project: r.topic } : {}),
          },
          ...(typeof r.createdAt === "string" ? { createdAt: r.createdAt } : {}),
        };
      });

      // Source + since filters are Cortex-side since engram doesn't
      // expose them as native filters today.
      let filtered = normalized;
      if (args.source) {
        filtered = filtered.filter((m) => {
          const meta = (m.metadata ?? {}) as Record<string, unknown>;
          return meta.source === args.source;
        });
      }
      if (args.project) {
        filtered = filtered.filter((m) => {
          const tags = m.tags ?? [];
          return tags.includes(`project:${args.project}`);
        });
      }
      if (args.sinceIso) {
        const since = Date.parse(args.sinceIso);
        filtered = filtered.filter((m) => {
          if (!m.createdAt) return true;
          const t = Date.parse(m.createdAt);
          return Number.isNaN(t) || t >= since;
        });
      }

      return filterByWorkspace(filtered, args.workspace);
    },

    async healthCheck(): Promise<HealthStatus> {
      try {
        const stats = await callJsonTool<Record<string, unknown>>(
          sub.client,
          "memory_stats",
          {},
        );
        lastSuccessAt = Date.now();
        return {
          healthy: true,
          message: "",
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
          details: stats ?? {},
        };
      } catch (err) {
        logger.warn("engram.healthcheck.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
        };
      }
    },

    async shutdown() {
      await sub.close();
    },

    async wipeAll() {
      // Dead path — buildClient is held over from the Engram-MCP-
      // subprocess era and isn't constructed in Cortex 0.3+. If
      // something starts using it again, wire to engram's
      // memory_clear tool (or equivalent) at that time.
      throw new Error(
        "wipeAll is not implemented for the legacy Engram subprocess client",
      );
    },

    // Generator never yields — this is a dead path that throws on call.
    // See wipeAll comment above. require-yield disabled here intentionally.
    // eslint-disable-next-line require-yield
    async *exportAll() {
      throw new Error(
        "exportAll is not implemented for the legacy Engram subprocess client",
      );
    },
  };
}
