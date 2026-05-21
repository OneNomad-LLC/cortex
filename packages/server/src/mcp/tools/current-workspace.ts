import { z } from "zod";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({});

interface Output {
  slug?: string;
  path?: string;
  note?: string;
}

/**
 * Return the currently active workspace. Useful at session start so
 * Claude can say "you're in the onenomad workspace" before answering
 * project-scoped questions.
 */
export const currentWorkspaceTool: McpTool<typeof inputSchema, Output> = {
  name: "current_workspace",
  description:
    "Return the currently active Cortex workspace. Returns an empty " +
    "result with a note when no workspace is active (legacy config " +
    "resolution mode).",
  inputSchema,

  async handler() {
    const active = await getActiveWorkspace();
    if (!active) {
      return {
        note: "No active workspace. Cortex is using legacy config resolution.",
      };
    }
    return { slug: active.slug, path: active.path };
  },
};
