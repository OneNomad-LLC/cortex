import { createHash } from "node:crypto";
import type { Logger } from "@onenomad/cortex-core";
import type { IdempotencyStore } from "./idempotency.js";
import { render, type TemplateName, type TemplateVars } from "./template.js";

/**
 * Where the formatted message goes. Pluggable so the same dispatcher
 * can later target email, OS notif, or a webhook without rewriting
 * the orchestration. Slack is the v1 transport; see
 * `@onenomad/cortex-pipeline-notification/dist/transports/slack.js`
 * once we move that out of `packages/server`.
 */
export interface NotificationTransport {
  send(args: { channel: string; message: string }): Promise<{ ok: boolean; detail?: string }>;
}

export type TriggerFlavor = "morning" | "pre-meeting" | "eod";

export interface DispatcherOptions {
  transport: NotificationTransport;
  idempotency: IdempotencyStore;
  logger: Logger;
  /**
   * Channel to deliver to. Slack expects either a channel id (e.g. `C…`),
   * a user id with `D…`, or `@username`. Sticking the resolved value
   * here at construction time keeps the per-fire path simple.
   */
  channel: string;
  /**
   * Inject a clock for tests. Defaults to `() => new Date()`.
   */
  now?: () => Date;
}

export interface FireArgs {
  flavor: TriggerFlavor;
  /** Caller-provided id. Used for idempotency + for naming the send. */
  triggerId: string;
  template: TemplateName;
  vars: TemplateVars;
  /**
   * If true, rendered message is logged but NOT sent + idempotency NOT
   * recorded. Lets `cortex notify --dry-run` exercise the whole
   * formatting path without spamming.
   */
  dryRun?: boolean;
}

export interface FireResult {
  status: "sent" | "skipped_duplicate" | "dry_run" | "transport_failed";
  triggerId: string;
  firedAt: string;
  message: string;
  detail?: string;
}

export interface NotificationDispatcher {
  fire(args: FireArgs): Promise<FireResult>;
}

export function createNotificationDispatcher(
  opts: DispatcherOptions,
): NotificationDispatcher {
  const now = opts.now ?? (() => new Date());

  return {
    async fire(args: FireArgs): Promise<FireResult> {
      const message = render(args.template, args.vars);
      const firedAt = now().toISOString();

      if (args.dryRun) {
        opts.logger.info("notification.dry_run", {
          flavor: args.flavor,
          triggerId: args.triggerId,
          length: message.length,
        });
        return {
          status: "dry_run",
          triggerId: args.triggerId,
          firedAt,
          message,
        };
      }

      // Dedupe BEFORE sending so a retry storm doesn't blast a peer.
      const prior = opts.idempotency.hasFired(args.triggerId);
      if (prior) {
        opts.logger.info("notification.skipped_duplicate", {
          flavor: args.flavor,
          triggerId: args.triggerId,
          priorFiredAt: prior,
        });
        return {
          status: "skipped_duplicate",
          triggerId: args.triggerId,
          firedAt: prior,
          message,
          detail: `already fired at ${prior}`,
        };
      }

      let sendResult: { ok: boolean; detail?: string };
      try {
        sendResult = await opts.transport.send({
          channel: opts.channel,
          message,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        opts.logger.error("notification.transport_threw", {
          flavor: args.flavor,
          triggerId: args.triggerId,
          error: detail,
        });
        return {
          status: "transport_failed",
          triggerId: args.triggerId,
          firedAt,
          message,
          detail,
        };
      }

      if (!sendResult.ok) {
        opts.logger.warn("notification.transport_rejected", {
          flavor: args.flavor,
          triggerId: args.triggerId,
          detail: sendResult.detail,
        });
        const result: FireResult = {
          status: "transport_failed",
          triggerId: args.triggerId,
          firedAt,
          message,
        };
        if (sendResult.detail !== undefined) result.detail = sendResult.detail;
        return result;
      }

      // Only record after a successful send. A failed transport leaves
      // the idempotency store untouched so the operator (or a retry
      // policy elsewhere) can replay.
      opts.idempotency.recordFire(args.triggerId, firedAt, hashPayload(message));
      opts.logger.info("notification.sent", {
        flavor: args.flavor,
        triggerId: args.triggerId,
        firedAt,
      });
      return {
        status: "sent",
        triggerId: args.triggerId,
        firedAt,
        message,
      };
    },
  };
}

function hashPayload(message: string): string {
  return createHash("sha256").update(message).digest("hex").slice(0, 16);
}
