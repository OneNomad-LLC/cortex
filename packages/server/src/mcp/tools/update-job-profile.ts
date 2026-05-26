import { z } from "zod";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import { upsertJobProfile } from "../../taxonomy-mutation.js";
import type { McpTool } from "../tool.js";
import type { JobProfile } from "@onenomad/przm-cortex-core";

const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case (a-z, 0-9, -)");

const inputSchema = z.object({
  title: z.string().min(1).optional(),
  employer: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  focusAreas: z.array(z.string().min(1)).optional(),
  responsibilities: z.string().min(1).optional(),
  stack: z.array(z.string().min(1)).optional(),
  managerSlug: slugSchema.optional(),
  directReports: z.array(slugSchema).optional(),
});

interface Output {
  profile: JobProfile;
}

/**
 * Patch the workspace's job profile. Only supplied fields overwrite;
 * everything else stays. Call this when the user shares work context
 * that should persist — title change, new focus area, joining a new
 * team, etc.
 */
export const updateJobProfileTool: McpTool<typeof inputSchema, Output> = {
  name: "update_job_profile",
  description:
    "Patch the user's job profile for the current workspace. Pass " +
    "only the fields that changed — title, employer, team, focus " +
    "areas, responsibilities, stack, manager slug, direct reports. " +
    "Idempotent and incremental. Use after the user shares work " +
    "context the assistant should remember (role change, new project, " +
    "new direct report).",
  inputSchema,

  async handler(input, ctx) {
    const ws = await requireSessionWorkspace();
    const patch: Partial<JobProfile> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.employer !== undefined) patch.employer = input.employer;
    if (input.team !== undefined) patch.team = input.team;
    if (input.focusAreas !== undefined) patch.focusAreas = input.focusAreas;
    if (input.responsibilities !== undefined) {
      patch.responsibilities = input.responsibilities;
    }
    if (input.stack !== undefined) patch.stack = input.stack;
    if (input.managerSlug !== undefined) patch.managerSlug = input.managerSlug;
    if (input.directReports !== undefined) {
      patch.directReports = input.directReports;
    }
    const profile = await upsertJobProfile({ repoRoot: ws.path }, patch);
    ctx.invalidateTaxonomy?.(ws.slug);
    return { profile };
  },
};
