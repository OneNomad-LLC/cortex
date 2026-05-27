import { z } from "zod";
import {
  getCurrentSessionId,
  getCurrentSessionState,
  setSessionWorkspace,
} from "../../session-context.js";
import {
  findWorkspace,
  getActiveWorkspace,
  listWorkspaces,
} from "../../cli/workspace/manager.js";
import { updateState } from "../../cli/workspace/state.js";
import type { McpTool } from "../tool.js";

/**
 * Session-scoped workspace tools.
 *
 * Pair with `list_workspaces` (already exists) for the first-message
 * prompt flow. Claude calls `get_session_workspace` early; if the
 * session isn't bound to one, asks the user; on their reply calls
 * `set_session_workspace` (or `add_workspace` for a new one).
 */

// ---- get_session_workspace -------------------------------------------

const getSchema = z.object({});
interface GetOutput {
  sessionId?: string;
  workspace: string | null;
  /**
   * Last-active workspace, offered as a resume default when the session
   * is unbound. Present only when `workspace` is null because the session
   * never picked one (not when the user explicitly chose "none").
   */
  suggestedWorkspace?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** When workspace is null, tells Claude what to do next. */
  guidance?: string;
}

export const getSessionWorkspace: McpTool<typeof getSchema, GetOutput> = {
  name: "get_session_workspace",
  description:
    "Return the workspace this MCP session is currently bound to. " +
    "ALWAYS call at the start of every conversation. When it returns " +
    "`workspace: null`, call `list_workspaces`, show the user their " +
    "options (existing / create new / work outside any workspace), " +
    "then call `set_session_workspace` with their choice. If " +
    "`suggestedWorkspace` is present it's the last-active workspace — " +
    "offer to resume it rather than prompting cold. Workspace-scoped " +
    "tools (memory, identity, adapters, ingest) require this to be set.",
  inputSchema: getSchema,
  async handler() {
    const sessionId = getCurrentSessionId();
    const state = getCurrentSessionState();
    // Distinguish "never picked" (undefined → suggest a resume) from
    // "explicitly chose none" (null → honor the opt-out).
    const bound = state?.workspace;
    const workspace = typeof bound === "string" ? bound : null;
    const out: GetOutput = {
      workspace,
      ...(sessionId ? { sessionId } : {}),
      ...(state?.firstSeenAt
        ? { firstSeenAt: new Date(state.firstSeenAt).toISOString() }
        : {}),
      ...(state?.lastSeenAt
        ? { lastSeenAt: new Date(state.lastSeenAt).toISOString() }
        : {}),
    };
    if (workspace === null) {
      if (bound === undefined) {
        // Unbound: suggest the last-active workspace so the client can
        // offer "resume <slug>?" instead of a cold onboarding prompt.
        const active = await getActiveWorkspace();
        if (active) {
          out.suggestedWorkspace = active.slug;
          out.guidance =
            `This session isn't bound to a workspace yet. Your last active ` +
            `workspace was '${active.slug}' — call ` +
            `set_session_workspace({ slug: "${active.slug}" }) to resume it, ` +
            `or list_workspaces to pick another (or "none" to run without ` +
            `one). Don't invent a workspace.`;
        } else {
          out.guidance =
            "This session isn't in a workspace yet. Call `list_workspaces`, " +
            "ask the user which one to use (or offer to create a new one, " +
            "or proceed without — in which case only global tools work), " +
            "then call `set_session_workspace` with their choice. Don't " +
            "invent a workspace.";
        }
      } else {
        // Explicit "none" — the user opted out; don't nag with a suggestion.
        out.guidance =
          "Running in no-workspace mode (you chose 'none'). Call " +
          "`set_session_workspace` with a slug to bind one.";
      }
    }
    return out;
  },
};

// ---- set_session_workspace -------------------------------------------

const setSchema = z.object({
  /**
   * Workspace slug to bind this session to. Pass empty string or
   * "none" to explicitly run in no-workspace mode (only global
   * tools usable).
   */
  slug: z.string(),
});
interface SetOutput {
  sessionId?: string;
  workspace: string | null;
  warning?: string;
}

export const setSessionWorkspaceTool: McpTool<typeof setSchema, SetOutput> = {
  name: "set_session_workspace",
  description:
    "Bind this MCP session to a workspace. The session id is " +
    "derived from the MCP `mcp-session-id` header automatically — " +
    "nothing for you to pass. Use after the user picks one from " +
    "`list_workspaces`, or pass \"none\" / empty string to run the " +
    "session without a workspace. Workspace-scoped tools gate on this.",
  inputSchema: setSchema,
  async handler(input, ctx) {
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      throw new Error(
        "no MCP session id in context — transport isn't binding sessions. " +
          "This should only happen in the stdio transport.",
      );
    }
    const raw = input.slug.trim();
    if (raw === "" || raw.toLowerCase() === "none") {
      setSessionWorkspace(sessionId, null);
      ctx.logger.info("session_workspace.set", { sessionId, workspace: null });
      return {
        sessionId,
        workspace: null,
        warning:
          "Running in no-workspace mode. Memory / identity / adapter tools will error until you call `set_session_workspace` with a real slug.",
      };
    }
    const found = await findWorkspace(raw);
    if (!found) {
      const known = await listWorkspaces();
      throw new Error(
        `workspace '${raw}' doesn't exist. Known: ${
          known.map((w) => w.slug).join(", ") || "(none)"
        }. Use \`add_workspace\` to create a new one.`,
      );
    }
    setSessionWorkspace(sessionId, found.slug);
    // Remember this as the last-active workspace so a future unbound
    // session can suggest resuming it (hybrid behavior). Binding to
    // "none" returns earlier and intentionally leaves the pointer alone.
    await updateState({ activeWorkspace: found.slug });
    ctx.logger.info("session_workspace.set", {
      sessionId,
      workspace: found.slug,
    });
    return { sessionId, workspace: found.slug };
  },
};
