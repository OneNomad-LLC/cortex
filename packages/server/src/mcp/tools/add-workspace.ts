import { z } from "zod";
import {
  createWorkspace,
  switchWorkspace,
} from "../../cli/workspace/manager.js";
import { readState } from "../../cli/workspace/state.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  slug: z.string().min(1),
  /**
   * Optional directory path to copy an existing cortex config from.
   * Useful for migrating the repo's ./config into a workspace —
   * pass the repo root.
   */
  fromPath: z.string().default(""),
  /**
   * When true and this is the first workspace, auto-activate.
   * Existing workspace state is respected; set `activate: true` to
   * also flip the pointer when a workspace is already active.
   */
  activate: z.boolean().default(false),
});

interface Output {
  slug: string;
  path: string;
  activated: boolean;
  activateWarning?: string;
}

/**
 * Create a new workspace. If none exist yet, the new one becomes
 * active automatically (same semantics as `cortex workspace add`).
 * Set `activate: true` to explicitly flip the pointer even when
 * another workspace is already active.
 */
export const addWorkspaceTool: McpTool<typeof inputSchema, Output> = {
  name: "add_workspace",
  description:
    "Create a new Cortex workspace. Slug must be kebab-case. Pass " +
    "`fromPath` to seed the workspace with an existing config dir + " +
    ".env (the repo root or any prior workspace). If this is your " +
    "first workspace it's auto-activated; otherwise pass " +
    "`activate: true` to switch to it.",
  inputSchema,

  async handler(input) {
    const ws = await createWorkspace({
      slug: input.slug,
      ...(input.fromPath ? { fromPath: input.fromPath } : {}),
    });

    const state = await readState();
    let activated = false;
    if (!state.activeWorkspace) {
      await switchWorkspace(ws.slug);
      activated = true;
    } else if (input.activate) {
      await switchWorkspace(ws.slug);
      activated = true;
    }

    const out: Output = {
      slug: ws.slug,
      path: ws.path,
      activated,
    };
    if (activated) {
      out.activateWarning =
        "If `cortex start` is running, restart it so the new workspace's config + Engram load.";
    }
    return out;
  },
};
