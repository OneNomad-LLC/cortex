import type { AnyMcpTool } from "../tool.js";
import { ALL_BROWSER_TOOLS } from "./browser.js";
import { addPerson } from "./add-person.js";
import { addProject } from "./add-project.js";
import { addWorkspaceTool } from "./add-workspace.js";
import { approveResearch } from "./approve-research.js";
import { catchMeUp } from "./catch-me-up.js";
import { catchMeUpOnMeeting } from "./catch-me-up-on-meeting.js";
import { currentWorkspaceTool } from "./current-workspace.js";
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
import { myActionItems } from "./my-action-items.js";
import { readSessionHandoffs } from "./read-session-handoffs.js";
import { research } from "./research.js";
import { resolveSessionHandoff } from "./resolve-session-handoff.js";
import { searchRelated } from "./search-related.js";
import {
  getSessionWorkspace,
  setSessionWorkspaceTool,
} from "./session-workspace.js";
import { switchWorkspaceTool } from "./switch-workspace.js";
import { todaysDigest } from "./todays-digest.js";
import { upcomingBriefs } from "./upcoming-briefs.js";
import { updateUserIdentity } from "./update-user-identity.js";

/**
 * Every MCP tool Cortex advertises. Add new tools here; the server will
 * pick them up automatically.
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
  catchMeUp,
  catchMeUpOnMeeting,
  myActionItems,
  upcomingBriefs,
  research,
  approveResearch,
  listUnclassified,
  todaysDigest,
  leaveSessionHandoff,
  readSessionHandoffs,
  resolveSessionHandoff,
  searchRelated,
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
  // Browser control — routed through the Cortex bridge to the
  // extension. Claude gets eyes + hands in the user's real browser.
  ...ALL_BROWSER_TOOLS,
];
