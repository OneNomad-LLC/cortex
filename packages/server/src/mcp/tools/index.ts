import type { AnyMcpTool } from "../tool.js";
import { addPersonTool } from "./add-person.js";
import { addProject } from "./add-project.js";
import { addWorkspaceTool } from "./add-workspace.js";
import { cortexGithubIngestRepo } from "./cortex-github-ingest-repo.js";
import { currentWorkspaceTool } from "./current-workspace.js";
import { getJobProfileTool } from "./get-job-profile.js";
import { getUserIdentityTool } from "./get-user-identity.js";
import { ingestContent } from "./ingest-content.js";
import { ingestFile } from "./ingest-file.js";
import { ingestRepo } from "./ingest-repo.js";
import { ingestUrl } from "./ingest-url.js";
import { kbDelete } from "./kb-delete.js";
import { kbDossier } from "./kb-dossier.js";
import { kbJobStatus } from "./kb-job-status.js";
import { kbRecent } from "./kb-recent.js";
import { kbSearch } from "./kb-search.js";
import { kbStats } from "./kb-stats.js";
import { listProjects } from "./list-projects.js";
import { listUnclassified } from "./list-unclassified.js";
import { listWorkspacesTool } from "./list-workspaces.js";
import { recentLogsTool } from "./recent-logs.js";
import { noteCreate } from "./note-create.js";
import { noteDelete } from "./note-delete.js";
import { noteGet } from "./note-get.js";
import { noteList } from "./note-list.js";
import { noteSuggestMetadata } from "./note-suggest-metadata.js";
import { noteUpdate } from "./note-update.js";
import { pendingEnrichmentRequests } from "./pending-enrichment-requests.js";
import { searchRelated } from "./search-related.js";
import {
  getSessionWorkspace,
  setSessionWorkspaceTool,
} from "./session-workspace.js";
import { submitEnrichmentResult } from "./submit-enrichment-result.js";
import { switchWorkspaceTool } from "./switch-workspace.js";
import { updateJobProfileTool } from "./update-job-profile.js";
import { updateUserIdentityTool } from "./update-user-identity.js";

/**
 * Every MCP tool Cortex advertises. Add new tools here; the server will
 * pick them up automatically.
 *
 * Architectural rule (Pyre Business Plan §16, 2026-05-10):
 *   Cortex is the knowledge source of truth, searchable by Pyre. That
 *   is its entire job. Cortex returns structured retrieval (chunks,
 *   entities, briefs, sources). Pyre composes language. No query-time
 *   LLM calls happen on Cortex; the only LLM work is ingest-time
 *   enrichment (brief, classify, structural).
 *
 * Knowledge-engine repositioning history:
 *  - 2026-05-09 Phase 1C: removed personal-priority tools — `digest`,
 *    `pending_action_items`, `summarize_recent`, `summarize_meeting`,
 *    session-handoff×3, `add_person`, `get_user_identity`,
 *    `update_user_identity`. Per-user identity + session continuity
 *    belong in Pyre's Engram (per-user memory) layer.
 *  - 2026-05-09 Phase 1D step 1: `project` is now optional on the four
 *    ingest_* tools (defaults to a sentinel "default" project).
 *  - 2026-05-09 Phase 1D step 2: removed the project-management MCP
 *    tools — `add_project`, `list_projects`, `get_project_context`,
 *    `get_taxonomy_gaps`. The project model is on its way out; no
 *    external client should be programmatically managing the project
 *    list any more. The CLI wizard at `cortex add projects` still
 *    works for users who want manual taxonomy curation.
 *    `get_project_context` lives on as an internal helper imported
 *    by `kb_dossier`'s project entity-type path.
 *  - 2026-05-26: restored `add_project` + `list_projects`. The ingest
 *    tools validate `project` against the taxonomy and their error
 *    text already pointed at both tools, but neither was exposed —
 *    so per-repo dossier scoping was impossible over MCP (every
 *    ingest fell back to "default"). Both are workspace-scoped and
 *    write through the same registry the ingest path reads.
 *  - 2026-05-10 Architecture-boundary cleanup: removed `research`,
 *    `approve_research` (query-time LLM synthesis — moves to Pyre),
 *    `fetch_pr`, `fetch_ticket` (user-auth fetch — moves to Pyre),
 *    and the 12 `browser_*` tools (browser-extension relay — Pyre
 *    talks to the extension directly now).
 *
 * See docs/MIGRATION-knowledge-engine.md.
 */
export const ALL_TOOLS: AnyMcpTool[] = [
  // Retrieval — the canonical surface for Pyre and other MCP clients.
  // search_related stays registered for back-compat with any pre-0.3
  // consumer that calls it by name.
  kbSearch,
  kbDossier,
  kbStats,
  kbDelete,
  kbRecent,
  kbJobStatus,
  listUnclassified,
  searchRelated,
  // Enrichment-protocol bridge — connected MCP clients (Pyre, Claude
  // Desktop, etc.) consume + answer enrichment requests when Cortex
  // has no local LLM. See docs/enrichment-protocol.md.
  pendingEnrichmentRequests,
  submitEnrichmentResult,
  // Workspaces — session-scoped (call get_session_workspace FIRST
  // in every new conversation) + the CLI-side list/add/switch.
  getSessionWorkspace,
  setSessionWorkspaceTool,
  listWorkspacesTool,
  currentWorkspaceTool,
  switchWorkspaceTool,
  addWorkspaceTool,
  // Identity + people taxonomy. Restored 2026-05-13 after the Phase
  // 1C strip: client MCP instructions (Claude Code's global CLAUDE.md
  // among others) call these at session start to anchor the
  // assistant to who the user is. Cortex Cloud seeds the `self`
  // person on first boot from deployment env vars, so a freshly
  // provisioned tenant lands with `get_user_identity` already
  // configured.
  getUserIdentityTool,
  updateUserIdentityTool,
  addPersonTool,
  getJobProfileTool,
  updateJobProfileTool,
  // Project taxonomy. Restored 2026-05-26 — ingest_* validate the
  // `project` arg against this list and point users at these two
  // tools when a slug is unknown. Workspace-scoped: both require a
  // bound session workspace.
  listProjects,
  addProject,
  // Persistent runtime log surface. Combines the in-memory ring with
  // the on-disk runtime.log so callers (Pyre's Activity tab) get logs
  // that survive Cortex restarts.
  recentLogsTool,
  // On-demand ingest. Phase 2 of the repositioning added ingest_url
  // and ingest_repo. ingest_file (text-only); PDF/DOCX/HTML coverage
  // remains a follow-up.
  ingestContent,
  ingestFile,
  ingestUrl,
  ingestRepo,
  // GitHub-specific shortcut. Wraps ingest_repo + adapter-github so an
  // MCP client can ask "ingest owner/name" without forcing the user
  // through the dashboard.
  cortexGithubIngestRepo,
  // Cortex-authored notes (Phase 1 — filesystem-backed via the
  // obsidian adapter's vault).
  noteCreate,
  noteUpdate,
  noteDelete,
  noteList,
  noteGet,
  noteSuggestMetadata,
];
