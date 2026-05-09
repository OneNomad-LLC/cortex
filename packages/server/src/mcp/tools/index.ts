import type { AnyMcpTool } from "../tool.js";
import { ALL_BROWSER_TOOLS } from "./browser.js";
import { addWorkspaceTool } from "./add-workspace.js";
import { approveResearch } from "./approve-research.js";
import { currentWorkspaceTool } from "./current-workspace.js";
import { fetchPr } from "./fetch-pr.js";
import { fetchTicket } from "./fetch-ticket.js";
import { ingestContent } from "./ingest-content.js";
import { ingestFile } from "./ingest-file.js";
import { ingestRepo } from "./ingest-repo.js";
import { ingestUrl } from "./ingest-url.js";
import { kbDelete } from "./kb-delete.js";
import { kbDossier } from "./kb-dossier.js";
import { kbRecent } from "./kb-recent.js";
import { kbSearch } from "./kb-search.js";
import { kbStats } from "./kb-stats.js";
import { listUnclassified } from "./list-unclassified.js";
import { listWorkspacesTool } from "./list-workspaces.js";
import { noteCreate } from "./note-create.js";
import { noteDelete } from "./note-delete.js";
import { noteGet } from "./note-get.js";
import { noteList } from "./note-list.js";
import { noteSuggestMetadata } from "./note-suggest-metadata.js";
import { noteUpdate } from "./note-update.js";
import { pendingEnrichmentRequests } from "./pending-enrichment-requests.js";
import { research } from "./research.js";
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
  research,
  approveResearch,
  listUnclassified,
  searchRelated,
  // Enrichment-protocol bridge — connected MCP clients (Pyre, Claude
  // Desktop, etc.) consume + answer enrichment requests when Cortex
  // has no local LLM. See docs/enrichment-protocol.md.
  pendingEnrichmentRequests,
  submitEnrichmentResult,
  // External fetches (PR review + ticket cross-ref flows).
  fetchPr,
  fetchTicket,
  // Workspaces — session-scoped (call get_session_workspace FIRST
  // in every new conversation) + the CLI-side list/add/switch.
  getSessionWorkspace,
  setSessionWorkspaceTool,
  listWorkspacesTool,
  currentWorkspaceTool,
  switchWorkspaceTool,
  addWorkspaceTool,
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
  // Browser control — routed through the Cortex bridge to the
  // extension. Claude gets eyes + hands in the user's real browser.
  ...ALL_BROWSER_TOOLS,
];
