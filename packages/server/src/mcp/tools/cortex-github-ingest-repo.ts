/**
 * `cortex_github_ingest_repo` — natural-language hook so an MCP client
 * (Claude Code, Claude Desktop, Pyre) can ask "ingest owner/name"
 * without the user opening the dashboard.
 *
 * Wraps adapter-github (it does NOT bypass it): the tool's job is to
 *   1. Normalize the input (owner/name slug, https URL, or git@ URL).
 *   2. Detect the already-connected case via the workspace's
 *      `adapters.github.config.repos` list.
 *   3. Verify access against GitHub's REST API using the device-flow
 *      token in the agent context (`tryReadGithubToken()`) or
 *      GITHUB_TOKEN env, so a 404 / 401 surfaces as a useful action
 *      ("not_accessible" / "auth_expired") rather than a sync failure
 *      hours later.
 *   4. On success, add the slug to cortex.yaml and enqueue a
 *      `github-sync` job that runs `ingest_repo` against the
 *      `https://github.com/owner/name.git` URL — same path the
 *      dashboard route uses, same persistent job registry so the
 *      caller can poll progress at `/_dashboard/jobs/<id>`.
 *
 * Why an MCP tool when the dashboard already does this: the MCP
 * surface runs inside an agent context with no session cookie — pyre's
 * "ingest owner/name" intent maps to this single tool call instead of
 * a multi-step browser flow.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tryReadGithubToken } from "@onenomad/przm-cortex-github-auth";
import type { McpTool, ToolContext } from "../tool.js";
import {
  appendGithubRepo,
  parseRepoIdentifier,
  readGithubRepoList,
} from "../../api/github-repo-config.js";
import { resolveConfigPath } from "../../cli/config-path.js";
import { jobs } from "../jobs.js";
import { ingestRepo } from "./ingest-repo.js";

const inputSchema = z.object({
  /**
   * Either `owner/name`, `https://github.com/owner/name(.git)?`, or
   * `git@github.com:owner/name.git`. Tree URLs (with `/blob/<ref>`)
   * are rejected — we want the canonical repo slug.
   */
  repo: z.string().min(3),
});

type Action =
  | "already_ingested"
  | "ingesting"
  | "not_accessible"
  | "auth_expired"
  | "github_not_configured"
  | "invalid_repo";

interface Output {
  action: Action;
  /** Canonical `owner/name` for the resolved input. Empty when invalid_repo. */
  repo: string;
  message: string;
  /** Present when action='ingesting' — poll via kb_job_status / dashboard. */
  jobId?: string;
  /** Reserved for the already_ingested branch. Populated once Slice C wires per-repo memory stats. */
  memoryCount?: number;
  lastSyncedAt?: string | null;
}

const TOOL_NAME = "cortex_github_ingest_repo";

export const cortexGithubIngestRepo: McpTool<typeof inputSchema, Output> = {
  name: TOOL_NAME,
  description:
    "Connect a GitHub repository to Cortex and queue a sync. Accepts " +
    "owner/name, https://github.com/owner/name, or git@github.com:owner/name. " +
    "Returns action='already_ingested' when the repo is already on the " +
    "sync list (resync via dashboard), 'ingesting' with a jobId on a new " +
    "connect, 'not_accessible' (404) when the GitHub token can't see the " +
    "repo, 'auth_expired' (401) when the token is invalid, or " +
    "'github_not_configured' when no token is set up yet.",
  inputSchema,

  async handler(input, ctx): Promise<Output> {
    const parsed = parseRepoIdentifier(input.repo);
    if (!parsed) {
      return {
        action: "invalid_repo",
        repo: "",
        message:
          "Could not parse repository identifier. Use owner/name, " +
          "https://github.com/owner/name, or git@github.com:owner/name.",
      };
    }
    const fullName = `${parsed.owner}/${parsed.name}`;

    // 1. Already-connected fast path. Reads the workspace's
    //    cortex.yaml — same file the dashboard mutates — so the two
    //    surfaces stay consistent.
    const configPath = resolveConfigPath();
    const existing = await readGithubRepoList(configPath);
    if (existing.includes(fullName)) {
      return {
        action: "already_ingested",
        repo: fullName,
        message:
          "Already connected. Use the dashboard to resync (Settings → " +
          "Integrations → GitHub).",
      };
    }

    // 2. Resolve a GitHub token. Device-flow token wins over env so
    //    users who ran `cortex github-login` don't also have to set
    //    GITHUB_TOKEN; falling back to env still lets server-only
    //    deployments work without the interactive flow.
    const tokenFile = await tryReadGithubToken();
    const token = tokenFile?.accessToken ?? process.env.GITHUB_TOKEN ?? "";
    if (!token) {
      return {
        action: "github_not_configured",
        repo: fullName,
        message:
          "GitHub is not connected. Run `cortex github-login` or sign in " +
          "via /_dashboard/integrations/github.",
      };
    }

    // 3. Verify access. A 200 means we can definitely sync; 404 is
    //    "the token doesn't have access" (private + missing scope, or
    //    deleted repo); 401 is "the token is bad".
    let verifyStatus = 0;
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "cortex-mcp",
          },
        },
      );
      verifyStatus = resp.status;
      // Drain the body so node doesn't keep the socket warm — we
      // already have the status, which is what gates the branches.
      await resp.text().catch(() => "");
    } catch (err) {
      ctx.logger.warn("mcp.cortex_github_ingest_repo.verify_failed", {
        repo: fullName,
        error: err instanceof Error ? err.message : String(err),
      });
      // Surface as not_accessible so the caller knows to retry — a
      // transient network blip shouldn't poison the YAML by adding a
      // repo we can't actually reach.
      return {
        action: "not_accessible",
        repo: fullName,
        message:
          "Could not reach GitHub to verify access. Retry, or check " +
          "your network / token.",
      };
    }

    if (verifyStatus === 401) {
      return {
        action: "auth_expired",
        repo: fullName,
        message:
          "GitHub token expired. Reauthenticate via " +
          "/_dashboard/integrations/github.",
      };
    }
    if (verifyStatus === 404 || verifyStatus === 403) {
      return {
        action: "not_accessible",
        repo: fullName,
        message:
          "Repo not in authorized scopes. Visit " +
          "/_dashboard/integrations/github to grant access.",
      };
    }
    if (verifyStatus < 200 || verifyStatus >= 300) {
      ctx.logger.warn("mcp.cortex_github_ingest_repo.verify_unexpected", {
        repo: fullName,
        status: verifyStatus,
      });
      return {
        action: "not_accessible",
        repo: fullName,
        message: `GitHub returned ${verifyStatus} verifying the repo. Try again or visit /_dashboard/integrations/github.`,
      };
    }

    // 4. Append + enqueue. We don't trigger a reload from the MCP
    //    side — the dashboard route does; the next scheduled adapter
    //    run picks up the new repo. The job we enqueue runs the
    //    ingest immediately so the caller has progress to poll.
    await appendGithubRepo(configPath, fullName);
    const job = jobs.create({ kind: "github-sync" });
    const work = async (): Promise<unknown> => {
      const traceId = randomUUID();
      const childCtx: ToolContext = {
        taxonomy: ctx.taxonomy,
        memoryTypes: ctx.memoryTypes,
        logger: ctx.logger.child({
          component: "github-sync",
          repo: fullName,
          traceId,
        }),
        engram: ctx.engram,
        ...(ctx.llmRouter ? { llmRouter: ctx.llmRouter } : {}),
        traceId,
        ...(ctx.sessionWorkspace !== undefined
          ? { sessionWorkspace: ctx.sessionWorkspace }
          : {}),
      };
      const inputParsed = ingestRepo.inputSchema.parse({
        path: `https://github.com/${fullName}.git`,
        project: "default",
        tags: [`github:${fullName}`],
        async: false,
      });
      return ingestRepo.handler(inputParsed, childCtx);
    };
    jobs.enqueue(job.id, work);

    return {
      action: "ingesting",
      repo: fullName,
      jobId: job.id,
      message: `Sync queued. View progress at /_dashboard/jobs/${job.id}.`,
    };
  },
};
