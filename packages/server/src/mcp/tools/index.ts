import type { AnyMcpTool } from "../tool.js";
import { addWorkspaceTool } from "./add-workspace.js";
import { currentWorkspaceTool } from "./current-workspace.js";
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
  // Cortex-authored notes (Phase 1 — filesystem-backed via the
  // obsidian adapter's vault).
  noteCreate,
  noteUpdate,
  noteDelete,
  noteList,
  noteGet,
  noteSuggestMetadata,
];
