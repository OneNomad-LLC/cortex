import type { AnyMcpTool } from "../tool.js";
import { catchMeUp } from "./catch-me-up.js";
import { catchMeUpOnMeeting } from "./catch-me-up-on-meeting.js";
import { getProjectContext } from "./get-project-context.js";
import { listProjects } from "./list-projects.js";
import { myActionItems } from "./my-action-items.js";
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
];
