import { z } from "zod";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import { readPeople } from "../../taxonomy-mutation.js";
import type { McpTool } from "../tool.js";
import type { Person } from "@onenomad/przm-cortex-core";

const inputSchema = z.object({});

interface Output {
  configured: boolean;
  identity?: Person;
  note?: string;
}

/**
 * Return the workspace's user identity — the person flagged `self: true`
 * in people.yaml. The MCP-client global instructions tell agents to call
 * this at session start so the assistant knows who they're talking to
 * (name, role, projects, timezone, working hours).
 *
 * Workspace-scoped. `configured: false` when no `self` person exists
 * yet — the caller can prompt the user for their details and then
 * invoke `update_user_identity` to persist them.
 */
export const getUserIdentityTool: McpTool<typeof inputSchema, Output> = {
  name: "get_user_identity",
  description:
    "Return the user identity for the current workspace (the person " +
    "marked `self: true` in people.yaml). Call this at session start " +
    "to learn who you're talking to — name, email, role, team, " +
    "projects, timezone, working hours. Returns `configured: false` " +
    "when no self-person exists yet; in that case, prompt the user " +
    "and call `update_user_identity` to persist.",
  inputSchema,

  async handler(_input, _ctx) {
    const ws = await requireSessionWorkspace();
    const people = await readPeople({ repoRoot: ws.path });
    const self = people.find((p) => p.self === true);
    if (!self) {
      return {
        configured: false,
        note:
          "No self-person configured for this workspace. Ask the user " +
          "for their name/email/role and call update_user_identity.",
      };
    }
    return { configured: true, identity: self };
  },
};
