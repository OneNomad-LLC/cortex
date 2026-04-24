import { z } from "zod";
import { maybeSessionWorkspace } from "../../session-workspace-helpers.js";
import { readPeople } from "../../taxonomy-mutation.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({});

interface Output {
  configured: boolean;
  identity: {
    slug?: string;
    name?: string;
    email?: string;
    role?: string;
    team?: string;
    timezone?: string;
    workHours?: string;
    aliases?: string[];
  };
  missing: string[];
  nextSteps: string[];
}

const INTERESTING_FIELDS: Array<keyof Output["identity"]> = [
  "slug",
  "name",
  "email",
  "role",
  "team",
  "timezone",
  "workHours",
];

/**
 * Returns the "who is the user" record. Always call this near the
 * start of a session — the `missing` array tells you which identity
 * fields to ask the user about before proceeding. Never fabricate
 * values; if `missing` is non-empty, ask the user one question at a
 * time in natural conversation, then persist via `update_user_identity`.
 */
export const getUserIdentity: McpTool<typeof inputSchema, Output> = {
  name: "get_user_identity",
  description:
    "Return the user's identity record (name, email, role, team, " +
    "timezone, aliases) plus a `missing` list of fields that aren't " +
    "set yet. ALWAYS call this once at session start. If `missing` " +
    "is non-empty, ask the user those questions naturally — don't " +
    "invent values — then save via `update_user_identity`. Subsequent " +
    "tool calls benefit from this context (surfacing mentions of the " +
    "user, resolving 'me', ranking due dates against workHours).",
  inputSchema,

  async handler() {
    // Read from the session's workspace. When the session isn't
    // bound (still-legacy client, or user explicitly picked "none"),
    // we can't return a meaningful identity record — signal that
    // back so the MCP instructions' prompt flow kicks in.
    const ws = await maybeSessionWorkspace();
    if (!ws) {
      return {
        configured: false,
        identity: {},
        missing: ["workspace"],
        nextSteps: [
          "This session isn't bound to a workspace. Call get_session_workspace → list_workspaces → set_session_workspace with the user's pick, then retry get_user_identity.",
        ],
      };
    }
    const people = await readPeople({ repoRoot: ws.path });
    const self = people.find((p) => p.self === true);
    if (!self) {
      return {
        configured: false,
        identity: {},
        missing: INTERESTING_FIELDS as string[],
        nextSteps: [
          "No user identity is saved yet. Ask the user their name, email, role, team, and timezone, then call update_user_identity with what you learn.",
        ],
      };
    }
    const identity: Output["identity"] = {
      slug: self.slug,
      name: self.name,
      email: self.email,
      ...(self.role ? { role: self.role } : {}),
      ...(self.team ? { team: self.team } : {}),
      ...(self.timezone ? { timezone: self.timezone } : {}),
      ...(self.workHours ? { workHours: self.workHours } : {}),
      ...(self.aliases.length > 0 ? { aliases: self.aliases } : {}),
    };
    const missing: string[] = [];
    for (const f of INTERESTING_FIELDS) {
      if (identity[f] === undefined) missing.push(f);
    }
    return {
      configured: true,
      identity,
      missing,
      nextSteps:
        missing.length > 0
          ? [
              `Known so far: ${self.name}. Still missing: ${missing.join(", ")}. Ask the user about those if the conversation invites it — don't interrogate.`,
            ]
          : [],
    };
  },
};
