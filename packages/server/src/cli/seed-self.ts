import {
  createWorkspace,
  getActiveWorkspace,
  switchWorkspace,
  type Workspace,
} from "./workspace/manager.js";
import { readPeople, markSelf, upsertPerson } from "../taxonomy-mutation.js";
import { upsertJobProfile } from "../taxonomy-mutation.js";
import type { Logger, Person, JobProfile } from "@onenomad/przm-cortex-core";

/**
 * Seed the workspace's `self` person from environment variables. The
 * intended caller is the Cortex Cloud startup path on Fly — pyre-web's
 * deploy action stamps the owner's identity onto the Fly machine env,
 * and a freshly-provisioned tenant comes up with `get_user_identity`
 * already configured.
 *
 * Idempotent: if a `self` person already exists in the active
 * workspace, the seed becomes an upsert that patches the supplied
 * fields (no surprise overwrites of identity edits the user has
 * since made via the MCP tool).
 *
 * Env contract:
 *   PRZM_CORTEX_SEED_SELF_SLUG       required to fire the seed
 *   PRZM_CORTEX_SEED_SELF_NAME       required
 *   PRZM_CORTEX_SEED_SELF_EMAIL      required
 *   PRZM_CORTEX_SEED_SELF_ROLE       optional
 *   PRZM_CORTEX_SEED_SELF_TEAM       optional
 *   PRZM_CORTEX_SEED_SELF_TIMEZONE   optional
 *   PRZM_CORTEX_SEED_SELF_WORKSPACE  optional — workspace slug to seed.
 *                               Defaults to the active workspace, or
 *                               "personal" when no workspace exists yet
 *                               (auto-creates + activates it).
 *
 * No-op when PRZM_CORTEX_SEED_SELF_SLUG is unset — self-hosted Cortex
 * installs don't carry the env vars and continue with the existing
 * web setup-wizard flow.
 */
export async function seedSelfFromEnv(logger: Logger): Promise<void> {
  const env = process.env;
  const slug = env.PRZM_CORTEX_SEED_SELF_SLUG;
  if (!slug) return;
  const name = env.PRZM_CORTEX_SEED_SELF_NAME;
  const email = env.PRZM_CORTEX_SEED_SELF_EMAIL;
  if (!name || !email) {
    logger.warn("seed_self.skipped_incomplete_env", {
      hasSlug: !!slug,
      hasName: !!name,
      hasEmail: !!email,
    });
    return;
  }

  let workspace: Workspace | undefined;
  const desiredSlug = env.PRZM_CORTEX_SEED_SELF_WORKSPACE ?? null;
  if (desiredSlug) {
    workspace = await getActiveWorkspace();
    if (!workspace || workspace.slug !== desiredSlug) {
      try {
        workspace = await createWorkspace({ slug: desiredSlug });
      } catch {
        // Most likely cause: already exists. Fall through to a
        // switch attempt below — createWorkspace throws on duplicate.
      }
      await switchWorkspace(desiredSlug).catch(() => undefined);
      workspace = await getActiveWorkspace();
    }
  } else {
    workspace = await getActiveWorkspace();
    if (!workspace) {
      const fallbackSlug = "personal";
      try {
        workspace = await createWorkspace({ slug: fallbackSlug });
      } catch {
        // exists — fall through to switch.
      }
      await switchWorkspace(fallbackSlug).catch(() => undefined);
      workspace = await getActiveWorkspace();
    }
  }

  if (!workspace) {
    logger.warn("seed_self.no_workspace_available", { desiredSlug });
    return;
  }

  const paths = { repoRoot: workspace.path };
  const existing = await readPeople(paths);
  const existingSelf = existing.find((p) => p.self === true);
  if (existingSelf && existingSelf.slug !== slug) {
    // Honor an identity the user already set; don't fight the MCP
    // tool's edits with a stale env-var seed. Log so operators can
    // see the seed was deliberately skipped.
    logger.info("seed_self.skipped_existing_self", {
      existingSlug: existingSelf.slug,
      envSlug: slug,
    });
    return;
  }

  const patch: Partial<Person> & { slug: string } = {
    slug,
    name,
    email,
    self: true,
  };
  if (env.PRZM_CORTEX_SEED_SELF_ROLE) patch.role = env.PRZM_CORTEX_SEED_SELF_ROLE;
  if (env.PRZM_CORTEX_SEED_SELF_TEAM) patch.team = env.PRZM_CORTEX_SEED_SELF_TEAM;
  if (env.PRZM_CORTEX_SEED_SELF_TIMEZONE) {
    patch.timezone = env.PRZM_CORTEX_SEED_SELF_TIMEZONE;
  }

  const { person, created } = await upsertPerson(paths, patch);
  await markSelf(paths, slug);
  logger.info("seed_self.applied", {
    workspace: workspace.slug,
    slug: person.slug,
    created,
  });

  // Optional job-profile seed — kept separate so a partial seed
  // (identity only) is the easy default. Fires only when title is
  // set; everything else is additive.
  const title = env.PRZM_CORTEX_SEED_JOB_TITLE;
  const employer = env.PRZM_CORTEX_SEED_JOB_EMPLOYER;
  if (title || employer) {
    const jobPatch: Partial<JobProfile> = {};
    if (title) jobPatch.title = title;
    if (employer) jobPatch.employer = employer;
    if (env.PRZM_CORTEX_SEED_JOB_TEAM) jobPatch.team = env.PRZM_CORTEX_SEED_JOB_TEAM;
    await upsertJobProfile(paths, jobPatch);
    logger.info("seed_self.job_profile_applied", {
      workspace: workspace.slug,
      title,
    });
  }
}
