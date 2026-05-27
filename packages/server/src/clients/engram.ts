import type { EngramAccess } from "@onenomad/przm-cortex-core";

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

