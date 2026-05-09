import type { AnyMcpTool } from "../tool.js";
import { ALL_BROWSER_TOOLS } from "./browser.js";
import { addProject } from "./add-project.js";
import { addWorkspaceTool } from "./add-workspace.js";
import { approveResearch } from "./approve-research.js";
import { currentWorkspaceTool } from "./current-workspace.js";
import { fetchPr } from "./fetch-pr.js";
import { fetchTicket } from "./fetch-ticket.js";
import { getProjectContext } from "./get-project-context.js";
import { getTaxonomyGaps } from "./get-taxonomy-gaps.js";
import { ingestContent } from "./ingest-content.js";
import { ingestFile } from "./ingest-file.js";
import { ingestRepo } from "./ingest-repo.js";
import { ingestUrl } from "./ingest-url.js";
import { listProjects } from "./list-projects.js";
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
 * Knowledge-engine repositioning (2026-05-09): personal-priority tools
 * removed — `digest`, `pending_action_items`, `summarize_recent`,
 * `summarize_meeting`, `leave_session_handoff` / `read_session_handoffs`
 * / `resolve_session_handoff`, `add_person`, `get_user_identity`,
 * `update_user_identity`. Cortex is now the multi-tenant knowledge
 * engine for Pyre; per-user identity + session continuity belong in
 * Pyre's Engram (per-user memory) layer, not here. See
 * docs/MIGRATION-knowledge-engine.md (Phase 1C).
 */
export const ALL_TOOLS: AnyMcpTool[] = [
  // Taxonomy + project surface (Phase 1D will flatten this further).
  getTaxonomyGaps,
  addProject,
  // Retrieval.
  listProjects,
  getProjectContext,
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
