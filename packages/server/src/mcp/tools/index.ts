import type { AnyMcpTool } from "../tool.js";
import { getProjectContext } from "./get-project-context.js";
import { listProjects } from "./list-projects.js";

/**
 * Every MCP tool Cortex advertises. Add new tools here; the server will
 * pick them up automatically.
 */
export const ALL_TOOLS: AnyMcpTool[] = [listProjects, getProjectContext];
