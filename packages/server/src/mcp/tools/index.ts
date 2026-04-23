import type { AnyMcpTool } from "../tool.js";
import { addWorkspaceTool } from "./add-workspace.js";
import { approveResearch } from "./approve-research.js";
import { catchMeUp } from "./catch-me-up.js";
import { catchMeUpOnMeeting } from "./catch-me-up-on-meeting.js";
import { currentWorkspaceTool } from "./current-workspace.js";
import { getProjectContext } from "./get-project-context.js";
import { leaveSessionHandoff } from "./leave-session-handoff.js";
import { listProjects } from "./list-projects.js";
import { listUnclassified } from "./list-unclassified.js";
import { listWorkspacesTool } from "./list-workspaces.js";
import { myActionItems } from "./my-action-items.js";
import { readSessionHandoffs } from "./read-session-handoffs.js";
import { research } from "./research.js";
import { resolveSessionHandoff } from "./resolve-session-handoff.js";
import { switchWorkspaceTool } from "./switch-workspace.js";
import { todaysDigest } from "./todays-digest.js";
import { upcomingBriefs } from "./upcoming-briefs.js";

/**
 * Every MCP tool Cortex advertises. Add new tools here; the server will
 * pick them up automatically.
 */
export const ALL_TOOLS: AnyMcpTool[] = [
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
  listWorkspacesTool,
  currentWorkspaceTool,
  switchWorkspaceTool,
  addWorkspaceTool,
];
