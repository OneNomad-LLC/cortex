import { z } from "zod";

/**
 * Workspace-scoped job profile — context about what the user *does*
 * for work, so the assistant can frame suggestions, summarize the
 * right channels, and route briefings to the right audience without
 * being asked every time.
 *
 * Lives on disk as `config/job-profile.yaml` under the workspace
 * root. Optional: when missing, `get_job_profile` returns
 * `configured: false` and the assistant should defer interrogation
 * until the user brings up something work-related.
 *
 * Distinct from `Person` (people.yaml `self` entry):
 *   - Person:        who the user is — name, email, timezone.
 *   - JobProfile:    what the user does — role context, focus areas,
 *                    employer, responsibilities.
 *
 * Kept lightweight on purpose. Free-form strings beat a frozen enum
 * for a fast-moving onboarding surface. The shape can grow as
 * usage patterns emerge.
 */
export const jobProfileSchema = z.object({
  /** Title or role at the employer — "Senior SWE", "PM", "Designer". */
  title: z.string().optional(),
  /** Company / employer name. Free-form. */
  employer: z.string().optional(),
  /** Team or org unit — "Platform", "Growth", "Design Systems". */
  team: z.string().optional(),
  /** Functional focus areas — "infra", "ML", "frontend perf". */
  focusAreas: z.array(z.string().min(1)).default([]),
  /**
   * Free-form description of current responsibilities — what the user
   * actually spends time on. Two to four sentences ideal; the
   * assistant uses this to tailor digests, briefs, and suggestions.
   */
  responsibilities: z.string().optional(),
  /**
   * Tools / stacks the user works in — "TypeScript", "Postgres",
   * "Kubernetes". Helps the assistant pick relevant examples + skip
   * irrelevant industry tropes.
   */
  stack: z.array(z.string().min(1)).default([]),
  /** Direct manager's people-slug, if tracked. */
  managerSlug: z.string().optional(),
  /** Direct reports' people-slugs. */
  directReports: z.array(z.string().min(1)).default([]),
});

export type JobProfile = z.infer<typeof jobProfileSchema>;

export const jobProfileFileSchema = z.object({
  profile: jobProfileSchema.optional(),
});

export type JobProfileFile = z.infer<typeof jobProfileFileSchema>;
