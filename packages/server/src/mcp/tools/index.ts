import type { AnyMcpTool } from "../tool.js";
import { ALL_BROWSER_TOOLS } from "./browser.js";
import { addPerson } from "./add-person.js";
import { addProject } from "./add-project.js";
import { addWorkspaceTool } from "./add-workspace.js";
import { approveResearch } from "./approve-research.js";
import { currentWorkspaceTool } from "./current-workspace.js";
import { digest } from "./digest.js";
import { fetchPr } from "./fetch-pr.js";
import { fetchTicket } from "./fetch-ticket.js";
import { getProjectContext } from "./get-project-context.js";
import { getTaxonomyGaps } from "./get-taxonomy-gaps.js";
import { getUserIdentity } from "./get-user-identity.js";
import { ingestContent } from "./ingest-content.js";
import { ingestFile } from "./ingest-file.js";
import { leaveSessionHandoff } from "./leave-session-handoff.js";
import { listProjects } from "./list-projects.js";
import { listUnclassified } from "./list-unclassified.js";
import { listWorkspacesTool } from "./list-workspaces.js";
import { noteCreate } from "./note-create.js";
import { noteDelete } from "./note-delete.js";
import { noteGet } from "./note-get.js";
import { noteList } from "./note-list.js";
import { noteSuggestMetadata } from "./note-suggest-metadata.js";
import { noteUpdate } from "./note-update.js";
import { pendingActionItems } from "./pending-action-items.js";
import { pendingEnrichmentRequests } from "./pending-enrichment-requests.js";
import { readSessionHandoffs } from "./read-session-handoffs.js";
import { research } from "./research.js";
import { resolveSessionHandoff } from "./resolve-session-handoff.js";
import { searchRelated } from "./search-related.js";
import {
  getSessionWorkspace,
  setSessionWorkspaceTool,
} from "./session-workspace.js";
import { submitEnrichmentResult } from "./submit-enrichment-result.js";
import { summarizeMeeting } from "./summarize-meeting.js";
import { summarizeRecent } from "./summarize-recent.js";
import { switchWorkspaceTool } from "./switch-workspace.js";
import { updateUserIdentity } from "./update-user-identity.js";

/**
 * Every MCP tool Cortex advertises. Add new tools here; the server will
 * pick them up automatically.
 *
 * Cortex 0.2 — time-relative tools (`todays_digest`, `catch_me_up`,
 * `catch_me_up_on_meeting`, `my_action_items`, `upcoming_briefs`)
 * were replaced with time-agnostic equivalents (`digest`,
 * `summarize_recent`, `summarize_meeting`, `pending_action_items`).
 * `upcoming_briefs` was deleted as personal-assistant scope that
 * doesn't fit the universal-knowledge framing.
 */
export const ALL_TOOLS: AnyMcpTool[] = [
  // Identity + taxonomy — these are the "learn about you" surface.
  // Claude is expected to call get_user_identity near session start.
  getUserIdentity,
  updateUserIdentity,
  getTaxonomyGaps,
  addPerson,
  addProject,
  // Retrieval.
  listProjects,
  getProjectContext,
  summarizeRecent,
  summarizeMeeting,
  pendingActionItems,
  research,
  approveResearch,
  listUnclassified,
  digest,
  leaveSessionHandoff,
  readSessionHandoffs,
  resolveSessionHandoff,
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
  // On-demand ingest.
  ingestContent,
  ingestFile,
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
