import {
  findWorkspace,
  getActiveWorkspace,
  type Workspace,
} from "./cli/workspace/manager.js";
import { getCurrentWorkspace } from "./session-context.js";

/**
 * Bridges the AsyncLocalStorage-tracked session workspace and the
 * on-disk workspace manager. Workspace-scoped tools call these to
 * resolve the filesystem paths they need (people.yaml, projects.yaml,
 * .env, etc.) from the session's binding rather than the legacy
 * process-global "active workspace" in state.json.
 *
 * Resolution order for every scoped tool:
 *   1. The session's explicit binding (set via set_session_workspace).
 *   2. The active workspace in state.json — for backwards compat
 *      with clients that haven't called set_session_workspace yet.
 *   3. Error ("no workspace — call set_session_workspace first").
 *
 * Tools that intentionally run outside a workspace (browser_*,
 * fetch_pr, fetch_ticket, list_workspaces, add_workspace, the
 * session-workspace tools themselves) never call these helpers and
 * are unaffected.
 */

export class NoWorkspaceBoundError extends Error {
  constructor(
    message = "This MCP session isn't bound to a Cortex workspace. Call `set_session_workspace({ slug })` first — run `list_workspaces` if you're not sure what's available, or `add_workspace` to make a new one. Workspace-scoped tools (memory, identity, taxonomy, adapters, ingest) require this.",
  ) {
    super(message);
    this.name = "NoWorkspaceBoundError";
  }
}

/**
 * Return the session's workspace slug, falling back to the CLI-side
 * active-workspace pointer for unbound sessions (old clients that
 * haven't adopted the prompt flow yet). Returns null only when the
 * user explicitly set the session to `"none"`.
 *
 * `undefined` means "nothing bound and no fallback" → caller should
 * throw NoWorkspaceBoundError.
 */
export async function resolveSessionWorkspaceSlug(): Promise<
  string | null | undefined
> {
  const session = getCurrentWorkspace();
  // User explicitly picked "no workspace" for this session — honor it.
  if (session === null) return null;
  if (typeof session === "string") return session;
  // Session never set; fall back to the CLI-side active pointer.
  const active = await getActiveWorkspace();
  return active?.slug;
}

/**
 * Resolve a full Workspace object (path, configPath, envPath) from
 * the session. Throws NoWorkspaceBoundError when there's nothing
 * bound or discoverable. Tools that write files (taxonomy, env,
 * job profile in future) need the path; retrieval tools can use
 * just the slug via resolveSessionWorkspaceSlug.
 */
export async function requireSessionWorkspace(): Promise<Workspace> {
  const slug = await resolveSessionWorkspaceSlug();
  if (!slug) throw new NoWorkspaceBoundError();
  const ws = await findWorkspace(slug);
  if (!ws) {
    throw new Error(
      `Session is bound to workspace '${slug}' but it no longer exists on disk. ` +
        `Pick a different one via \`set_session_workspace\` or \`list_workspaces\`.`,
    );
  }
  return ws;
}

/**
 * Variant that returns null when the session is explicitly in
 * no-workspace mode, or the Workspace when one is resolvable.
 * Tools that want to gracefully skip (e.g. retrieval tools that can
 * still answer from global state) use this instead of the throwing
 * version.
 */
export async function maybeSessionWorkspace(): Promise<Workspace | null> {
  const slug = await resolveSessionWorkspaceSlug();
  if (!slug) return null;
  const ws = await findWorkspace(slug);
  return ws ?? null;
}
