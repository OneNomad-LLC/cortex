import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  RawSourceItem,
  VerifyResult,
  WebhookHandler,
  WebhookRequest,
} from "@onenomad/przm-cortex-core";
import { matchesGlobs } from "@onenomad/przm-cortex-adapter-sdk";

export interface GithubWebhookOptions {
  /**
   * Shared secret configured at the GitHub webhook UI. When set, incoming
   * requests must carry a valid `X-Hub-Signature-256` header. If unset, no
   * request is accepted — unlike some services, GitHub's webhooks are only
   * safe with a secret, so we refuse to run in "insecure mode".
   */
  secret: string;
  /** URL path to mount at. Default `/webhooks/github`. */
  path?: string;
  /** Glob filter reused from adapter config. */
  includeGlobs: readonly string[];
  excludeGlobs: readonly string[];
  /** Owner/repo → project mapping from adapter config (for source_id stability). */
  repoToProject: Record<string, string>;
  /** Cap emitted items per request. Defaults to 100 — huge PR merges can
   *  legitimately touch more files, but that's rare and a separate sync
   *  will catch them. */
  maxItemsPerEvent?: number;
}

interface PushPayload {
  ref?: string;
  repository?: { full_name?: string };
  commits?: Array<{
    id?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
  head_commit?: {
    id?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  };
}

/**
 * GitHub webhook handler. Supports `push` events today — each commit's
 * `added` + `modified` file lists are turned into RawSourceItems matching
 * the shape that `fetch()` would produce, so the downstream transform +
 * pipeline logic is oblivious to the entry point.
 *
 * Security model:
 *   - HMAC-SHA256 signature verification using the configured secret.
 *   - timingSafeEqual for the compare to avoid timing oracles.
 *   - Reject requests that don't carry the expected header; leak no
 *     detail back to the caller.
 */
export function createGithubWebhook(
  opts: GithubWebhookOptions,
): WebhookHandler {
  if (!opts.secret) {
    throw new Error(
      "github webhook: GITHUB_WEBHOOK_SECRET must be set (we refuse to run without signature verification).",
    );
  }

  const path = opts.path ?? "/webhooks/github";
  const maxItems = opts.maxItemsPerEvent ?? 100;

  return {
    path,
    methods: ["POST"],

    verify(req: WebhookRequest): VerifyResult {
      const sig = req.headers["x-hub-signature-256"];
      if (!sig) return { ok: false, reason: "missing x-hub-signature-256" };
      const expected = `sha256=${createHmac("sha256", opts.secret)
        .update(req.rawBody)
        .digest("hex")}`;
      // Buffers must be the same length for timingSafeEqual; fall through
      // to an explicit mismatch if the client sent something shorter.
      if (sig.length !== expected.length) return { ok: false, reason: "sig length mismatch" };
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (!timingSafeEqual(a, b)) return { ok: false, reason: "sig mismatch" };
      return { ok: true };
    },

    parse(req: WebhookRequest): RawSourceItem[] {
      const event = req.headers["x-github-event"] ?? "";
      if (event !== "push") return []; // ignore other events for now
      let payload: PushPayload;
      try {
        payload = JSON.parse(req.rawBody) as PushPayload;
      } catch {
        return [];
      }
      const fullName = payload.repository?.full_name;
      if (!fullName) return [];
      const [owner, repo] = splitRepo(fullName);
      const branch = refToBranch(payload.ref ?? "");
      if (!branch) return [];

      const seenPaths = new Set<string>();
      const out: RawSourceItem[] = [];

      const addCommit = (commit: {
        id?: string;
        added?: string[];
        modified?: string[];
      }): void => {
        const sha = commit.id ?? "";
        const paths = [
          ...(commit.added ?? []),
          ...(commit.modified ?? []),
        ];
        for (const p of paths) {
          if (seenPaths.has(p)) continue;
          if (!matchesGlobs(p, opts.includeGlobs, opts.excludeGlobs)) continue;
          seenPaths.add(p);
          if (out.length >= maxItems) return;
          out.push({
            // source_id shape mirrors fetch() so re-ingests upsert rather
            // than duplicating.
            sourceId: `github:${fullName}@${branch}:${p}`,
            raw: {
              owner,
              repo,
              branch,
              sha,
              path: p,
              /** Marks this as webhook-delivered so transform() knows to
                *  fetch content lazily rather than expecting it inline. */
              _webhook: true,
            },
          });
        }
      };

      for (const commit of payload.commits ?? []) addCommit(commit);
      if (payload.head_commit) addCommit(payload.head_commit);

      return out;
    },
  };
}

function splitRepo(fullName: string): [string, string] {
  const idx = fullName.indexOf("/");
  if (idx < 0) return [fullName, ""];
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}

/** `refs/heads/main` → `main`. Returns empty string for unusable refs. */
function refToBranch(ref: string): string {
  const prefix = "refs/heads/";
  if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  return "";
}
