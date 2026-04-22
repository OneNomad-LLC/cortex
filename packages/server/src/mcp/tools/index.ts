import type { AnyMcpTool } from "../tool.js";
import { catchMeUp } from "./catch-me-up.js";
import { catchMeUpOnMeeting } from "./catch-me-up-on-meeting.js";
import { getProjectContext } from "./get-project-context.js";
import { listProjects } from "./list-projects.js";
import { listUnclassified } from "./list-unclassified.js";
import { myActionItems } from "./my-action-items.js";
import { research } from "./research.js";
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
  listUnclassified,
  todaysDigest,
];
