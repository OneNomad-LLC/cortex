import { z } from "zod";
import {
  getActiveWorkspace,
  listWorkspaces,
} from "../../cli/workspace/manager.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({});

interface WorkspaceRow {
  slug: string;
  path: string;
  active: boolean;
}

interface Output {
  workspaces: WorkspaceRow[];
  active?: string;
  note?: string;
}

/**
 * Read-only list of all Cortex workspaces on this machine. Safe to
 * call from any Claude surface — no state change, no side effects.
 */
export const listWorkspacesTool: McpTool<typeof inputSchema, Output> = {
  name: "list_workspaces",
  description:
    "List every Cortex workspace configured on this machine and mark " +
    "the active one. Workspaces are named bundles of config + .env + " +
    "memory state — use them to separate work contexts (e.g. one per " +
    "employer, plus personal).",
  inputSchema,

  async handler() {
    const [workspaces, active] = await Promise.all([
      listWorkspaces(),
      getActiveWorkspace(),
    ]);
    const rows: WorkspaceRow[] = workspaces.map((w) => ({
      slug: w.slug,
      path: w.path,
      active: active?.slug === w.slug,
    }));
    const out: Output = { workspaces: rows };
    if (active) out.active = active.slug;
    if (rows.length === 0) {
      out.note =
        "No workspaces exist yet. Call `add_workspace` or run `cortex workspace add <slug>` in the terminal.";
    }
    return out;
  },
};
