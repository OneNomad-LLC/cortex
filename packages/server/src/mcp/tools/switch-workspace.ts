import { z } from "zod";
import { switchWorkspace } from "../../cli/workspace/manager.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  slug: z.string().min(1),
});

interface Output {
  slug: string;
  path: string;
  warning: string;
}

/**
 * Flip the active workspace pointer. The state file is updated
 * immediately; future `cortex` invocations see the new workspace.
 *
 * Important: a running `cortex start` holds Engram + config in
 * memory from the workspace it started with. Switching via this
 * tool does NOT hot-reload — the daemon (and this MCP session) are
 * still looking at the old workspace's data until restart. The
 * output's `warning` field surfaces that so Claude can relay it.
 */
export const switchWorkspaceTool: McpTool<typeof inputSchema, Output> = {
  name: "switch_workspace",
  description:
    "Flip the active Cortex workspace to the given slug. Writes to " +
    "state.json; future CLI invocations pick up the new workspace. " +
    "IMPORTANT: if `cortex start` is running, it must be restarted " +
    "for its MCP tools and dashboard to load the new workspace's " +
    "memory. This tool returns a `warning` field with that note.",
  inputSchema,

  async handler(input) {
    const ws = await switchWorkspace(input.slug);
    return {
      slug: ws.slug,
      path: ws.path,
      warning:
        "Workspace switched in state.json, but the running cortex daemon is still " +
        "holding the previous workspace's config + Engram subprocess. Restart " +
        "`cortex start` (and refresh the dashboard) to load this workspace's data.",
    };
  },
};
