/**
 * RBAC scope bundles for MCP tool access. A bearer (CLI JWT) carries
 * a `scopes` claim — an array of bundle names — and the MCP server
 * filters its tool surface against the union of those bundles' tools.
 *
 * Three canonical bundles, picked to match the typical operator shape:
 *
 *   read    — retrieval surface. Safe for analysts, auditors, anyone
 *             who shouldn't be writing to the workspace.
 *   ingest  — read + write paths that put data into Cortex (docs,
 *             URLs, repos, files). The default for active operators.
 *   admin   — everything. Workspace mutation (people, projects),
 *             identity/job-profile, dangerous wipes, governance,
 *             memory-type registry.
 *
 * Custom bundles can be defined per-tenant on pyre-web's RBAC
 * settings page (future); they get stamped into the JWT under the
 * same `scopes` claim alongside the canonical names. Cortex resolves
 * unknown scope names to an empty tool set (fail-closed).
 */

export type ScopeName = "read" | "ingest" | "admin" | (string & {});

/**
 * Static mapping from canonical scope to tool names. Tool names match
 * the `name` field on each McpTool. Adding a new tool defaults to the
 * `admin` bundle until it's explicitly added to a lower-trust bundle —
 * fail-closed so a freshly-shipped retrieval helper doesn't
 * accidentally leak from `admin` into `read`.
 */
export const CANONICAL_SCOPE_BUNDLES: Record<"read" | "ingest" | "admin", readonly string[]> = {
  read: [
    "kb_search",
    "kb_dossier",
    "kb_stats",
    "kb_recent",
    "kb_job_status",
    "list_unclassified",
    "search_related",
    "get_session_workspace",
    "current_workspace",
    "list_workspaces",
    "recent_logs",
    "note_list",
    "note_get",
    "get_user_identity",
    "get_job_profile",
  ],
  ingest: [
    // Inherits everything from `read` at expand time — this list is
    // the *additive* slice.
    "ingest_content",
    "ingest_file",
    "ingest_url",
    "ingest_repo",
    "note_create",
    "note_update",
    "note_suggest_metadata",
    "set_session_workspace",
    "submit_enrichment_result",
    "pending_enrichment_requests",
  ],
  admin: [
    // Same posture — additive on top of `ingest`. Anything not named
    // explicitly here that lands in admin (the default for new tools)
    // is unioned in via the expand step below.
    "kb_delete",
    "note_delete",
    "switch_workspace",
    "add_workspace",
    "update_user_identity",
    "add_person",
    "update_job_profile",
  ],
};

/**
 * Expand a list of scope names into the concrete tool-name set the
 * bearer is allowed to call. `admin` implies `ingest` implies `read`
 * — the bundles cascade so callers don't need to enumerate all three
 * to grant admin.
 *
 * Unknown scope names are dropped silently (fail-closed). When the
 * input is empty, the result is empty too — a "no scopes" claim
 * means no tools, not all tools.
 */
export function expandScopes(scopes: readonly string[]): Set<string> {
  const out = new Set<string>();
  const includeRead = scopes.includes("read") || scopes.includes("ingest") || scopes.includes("admin");
  const includeIngest = scopes.includes("ingest") || scopes.includes("admin");
  const includeAdmin = scopes.includes("admin");
  if (includeRead) for (const t of CANONICAL_SCOPE_BUNDLES.read) out.add(t);
  if (includeIngest) for (const t of CANONICAL_SCOPE_BUNDLES.ingest) out.add(t);
  if (includeAdmin) for (const t of CANONICAL_SCOPE_BUNDLES.admin) out.add(t);
  return out;
}

/**
 * Map a pyre-web tenant role to the canonical scope name. The CLI
 * login flow looks up the operator's role and stamps the
 * corresponding scope into the issued JWT.
 *
 *   owner | admin   → admin   (full surface)
 *   member          → ingest  (read + write to workspace)
 *   viewer          → read    (retrieval only)
 *
 * Roles outside this set get `read` (least privilege).
 */
export function tenantRoleToScope(
  role: "owner" | "admin" | "member" | "viewer" | string,
): "read" | "ingest" | "admin" {
  if (role === "owner" || role === "admin") return "admin";
  if (role === "member") return "ingest";
  return "read";
}
