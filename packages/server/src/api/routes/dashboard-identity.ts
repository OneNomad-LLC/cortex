/**
 * `/api/dashboard/identity` — surfaces the workspace's self-person +
 * job profile to the dashboard, with PATCH endpoints that wrap the
 * existing taxonomy mutation helpers.
 *
 * Surface:
 *   GET  /api/dashboard/identity
 *     → 200 {
 *         self: PersonInfo | null,
 *         jobProfile:
 *           | { available: true, profile: JobProfile | null }
 *           | { available: false }
 *       }
 *   POST /api/dashboard/identity/self          body: PersonPatch
 *     → 200 { ok: true, identity: PersonInfo }
 *   POST /api/dashboard/identity/job-profile   body: Partial<JobProfile>
 *     → 200 { ok: true, profile: JobProfile }
 *     → 404 { error: "module_unavailable" } when job-profile module is
 *           not wired on this Cortex install
 *
 * All routes are admin-gated. Identity is single-source-of-truth for
 * who the dashboard thinks the user is — read access alone is
 * sufficient justification for "admin" here.
 *
 * The job profile module is part of the private-modules surface; in
 * an open-source build it MAY be missing. We import it dynamically so
 * builds without it still typecheck + run, and we return a 404 with
 * `error: "module_unavailable"` so the client can render a
 * "not configured" affordance instead of an error toast.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import { findWorkspace } from "../../cli/workspace/manager.js";
import {
  markSelf,
  readPeople,
  upsertPerson,
} from "../../taxonomy-mutation.js";
import type { JobProfile, Person } from "@onenomad/przm-cortex-core";

/** Best-effort dynamic import of the job-profile helpers. */
type JobProfileAccessor = {
  readJobProfile: (paths: { repoRoot: string }) => Promise<JobProfile | undefined>;
  upsertJobProfile: (
    paths: { repoRoot: string },
    patch: Partial<JobProfile>,
  ) => Promise<JobProfile>;
};

async function loadJobProfileAccessor(): Promise<JobProfileAccessor | null> {
  try {
    const mod = (await import("../../taxonomy-mutation.js")) as Partial<JobProfileAccessor>;
    if (
      typeof mod.readJobProfile === "function" &&
      typeof mod.upsertJobProfile === "function"
    ) {
      return {
        readJobProfile: mod.readJobProfile,
        upsertJobProfile: mod.upsertJobProfile,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;
  if (
    pathname !== "/api/dashboard/identity" &&
    !pathname.startsWith("/api/dashboard/identity/")
  ) {
    return false;
  }

  const gate = requireDashboardAuth(["admin"]);

  try {
    if (req.method === "GET" && pathname === "/api/dashboard/identity") {
      const resolved = await gate(req, res);
      if (!resolved) return true;
      const ws = await resolveSessionWorkspace(resolved.session.workspace);
      if (!ws) {
        sendJson(res, 400, { error: "no_workspace_bound" });
        return true;
      }

      const people = await readPeople({ repoRoot: ws.path });
      const self = people.find((p) => p.self === true) ?? null;

      const jp = await loadJobProfileAccessor();
      let jobProfile:
        | { available: true; profile: JobProfile | null }
        | { available: false };
      if (!jp) {
        jobProfile = { available: false };
      } else {
        const profile = (await jp.readJobProfile({ repoRoot: ws.path })) ?? null;
        jobProfile = { available: true, profile };
      }

      sendJson(res, 200, {
        self,
        jobProfile,
      });
      return true;
    }

    if (
      req.method === "POST" &&
      pathname === "/api/dashboard/identity/self"
    ) {
      const resolved = await gate(req, res);
      if (!resolved) return true;
      const ws = await resolveSessionWorkspace(resolved.session.workspace);
      if (!ws) {
        sendJson(res, 400, { error: "no_workspace_bound" });
        return true;
      }
      const body = (await readJsonBody(req).catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const slug = readString(body.slug);
      const name = readString(body.name);
      const email = readString(body.email);
      if (!slug || !name || !email) {
        sendJson(res, 400, {
          error: "invalid_body",
          message: "slug, name, email required",
        });
        return true;
      }
      const patch: Partial<Person> & { slug: string } = {
        slug,
        name,
        email,
        self: true,
      };
      const role = readString(body.role);
      if (role) patch.role = role;
      const team = readString(body.team);
      if (team) patch.team = team;
      const tz = readString(body.timezone);
      if (tz) patch.timezone = tz;
      const hours = readString(body.workHours);
      if (hours) patch.workHours = hours;
      const projects = readStringArray(body.projects);
      if (projects) patch.projects = projects;
      const aliases = readStringArray(body.aliases);
      if (aliases) patch.aliases = aliases;

      const paths = { repoRoot: ws.path };
      const { person } = await upsertPerson(paths, patch);
      await markSelf(paths, slug);
      sendJson(res, 200, {
        ok: true,
        identity: { ...person, self: true },
      });
      return true;
    }

    if (
      req.method === "POST" &&
      pathname === "/api/dashboard/identity/job-profile"
    ) {
      const resolved = await gate(req, res);
      if (!resolved) return true;
      const ws = await resolveSessionWorkspace(resolved.session.workspace);
      if (!ws) {
        sendJson(res, 400, { error: "no_workspace_bound" });
        return true;
      }
      const jp = await loadJobProfileAccessor();
      if (!jp) {
        sendJson(res, 404, { error: "module_unavailable" });
        return true;
      }
      const body = (await readJsonBody(req).catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const patch: Partial<JobProfile> = {};
      const title = readString(body.title);
      if (title) patch.title = title;
      const employer = readString(body.employer);
      if (employer) patch.employer = employer;
      const team = readString(body.team);
      if (team) patch.team = team;
      const focus = readStringArray(body.focusAreas);
      if (focus) patch.focusAreas = focus;
      const responsibilities = readString(body.responsibilities);
      if (responsibilities) patch.responsibilities = responsibilities;
      const stack = readStringArray(body.stack);
      if (stack) patch.stack = stack;
      const managerSlug = readString(body.managerSlug);
      if (managerSlug) patch.managerSlug = managerSlug;
      const directReports = readStringArray(body.directReports);
      if (directReports) patch.directReports = directReports;

      const profile = await jp.upsertJobProfile({ repoRoot: ws.path }, patch);
      sendJson(res, 200, { ok: true, profile });
      return true;
    }

    sendJson(res, 404, { error: "not_found" });
    return true;
  } catch (err) {
    ctx.logger.warn("dashboard.identity.unhandled", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: "internal",
      message: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

async function resolveSessionWorkspace(
  bound: string | null | undefined,
): Promise<{ slug: string; path: string } | null> {
  if (!bound) return null;
  const ws = await findWorkspace(bound);
  return ws ? { slug: ws.slug, path: ws.path } : null;
}

function readString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}
