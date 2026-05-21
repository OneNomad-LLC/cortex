import { z } from "zod";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import { readJobProfile } from "../../taxonomy-mutation.js";
import type { McpTool } from "../tool.js";
import type { JobProfile } from "@onenomad/przm-cortex-core";

const inputSchema = z.object({});

interface Output {
  configured: boolean;
  profile?: JobProfile;
  note?: string;
}

/**
 * Return the workspace's job profile — what the user does for work.
 *
 * The MCP client's session-start protocol is to call this *after*
 * `get_user_identity`. When it returns `configured: false`, the
 * assistant should NOT interrogate the user up front — wait until
 * something work-relevant comes up, then mention it once.
 *
 * Workspace-scoped. Profile lives at `config/job-profile.yaml`.
 */
export const getJobProfileTool: McpTool<typeof inputSchema, Output> = {
  name: "get_job_profile",
  description:
    "Return the user's job profile for the current workspace — title, " +
    "employer, team, focus areas, responsibilities, stack. Returns " +
    "`configured: false` when the profile is empty; in that case, " +
    "defer interrogation until something work-related comes up, then " +
    "mention it once.",
  inputSchema,

  async handler(_input, _ctx) {
    const ws = await requireSessionWorkspace();
    const profile = await readJobProfile({ repoRoot: ws.path });
    if (!profile) {
      return {
        configured: false,
        note:
          "No job profile configured for this workspace. Defer " +
          "interrogation until a work-related ask comes up.",
      };
    }
    return { configured: true, profile };
  },
};
