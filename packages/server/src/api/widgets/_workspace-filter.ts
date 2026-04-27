/**
 * Phase 1b — workspace bleed fix. Post-fetch filter for memories returned
 * by `ctx.engram.search(...)`. Drops memories whose `metadata.workspace`
 * doesn't match the per-request workspace slug (set by the dashboard's
 * `?workspace=<slug>` query param, resolved into `ctx.workspace`).
 *
 * Memories are stamped with `metadata.workspace` at ingest time by the
 * `ingest_content` MCP tool (packages/server/src/mcp/tools/ingest-content.ts).
 * Legacy memories from before workspace support exist without this field —
 * those are EXCLUDED when a workspace filter is active. To surface them
 * to a workspace-scoped session, re-ingest with the new tool.
 *
 * Engram-side metadata filtering (push the predicate into the index query
 * for perf) is a v8 follow-up — `EngramClient.search()` doesn't expose a
 * metadata filter today. Post-fetch is fine for v1 since result sets are
 * small (single-digit-to-low-hundreds of rows after the search limit).
 */

export interface WorkspaceLike {
  slug: string;
}

export interface MemoryLike {
  metadata?: Record<string, unknown> | null;
}

export function filterByWorkspace<T extends MemoryLike>(
  memories: readonly T[],
  workspace: WorkspaceLike | undefined,
): T[] {
  if (!workspace) return [...memories];
  const slug = workspace.slug;
  return memories.filter((m) => {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return meta.workspace === slug;
  });
}
