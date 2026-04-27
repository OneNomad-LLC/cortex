import { homedir } from "node:os";
import { join } from "node:path";
import {
  createNotificationDispatcher,
  createNotificationScheduler,
  openIdempotencyStore,
  type NotificationScheduler,
  type NotificationTransport,
  type ScheduledTriggerSpec,
  type FireArgs,
} from "@onenomad/cortex-pipeline-notification";
import { SlackClient } from "@onenomad/cortex-adapter-slack";
import type { Logger } from "@onenomad/cortex-core";
import { buildPlaceholderVars, buildTriggerId, flavorToTemplate } from "./cli/notify-args.js";

/**
 * Bootstrap the notification scheduler at server startup. Returns a
 * stoppable handle. No-op (returns null) when SLACK_TOKEN is absent —
 * server boot shouldn't fail just because Slack isn't wired yet.
 *
 * What this PR ships:
 *   - 8am morning + 5pm eod daily fire (placeholder vars)
 *   - pre-meeting hook is plumbed but `fetchEvents` returns []
 *     until the calendar-source wiring lands in the next PR
 *
 * What's deferred:
 *   - Real data plumbing — call today-meetings + priorities +
 *     upcoming-briefs handlers to populate vars (next PR)
 *   - notifications.yaml workspace config (next PR)
 *   - calendar-source events for the pre-meeting trigger (next PR)
 */
export interface NotificationBootstrapOptions {
  logger: Logger;
  /** Override Slack channel. Default `@self`. */
  channel?: string;
}

export interface NotificationBootstrapResult {
  scheduler: NotificationScheduler;
  stop(): Promise<void>;
}

export async function bootstrapNotifications(
  opts: NotificationBootstrapOptions,
): Promise<NotificationBootstrapResult | null> {
  const token = process.env.SLACK_TOKEN ?? "";
  if (!token) {
    opts.logger.info("notification.bootstrap.skip_no_token");
    return null;
  }
  const channel = opts.channel ?? "@self";

  const idempotencyPath = join(homedir(), ".cortex", "notifications.db");
  const idempotency = openIdempotencyStore(idempotencyPath);
  const slack = new SlackClient({ token });

  const transport: NotificationTransport = {
    async send(args) {
      const res = await slack.postMessage({
        channel: args.channel,
        text: args.message,
      });
      if (res.ok) return { ok: true };
      return { ok: false, detail: res.error ?? "unknown" };
    },
  };

  const dispatcher = createNotificationDispatcher({
    transport,
    idempotency,
    logger: opts.logger.child({ component: "notification-dispatcher" }),
    channel,
  });

  // 8am morning + 5pm eod, both with placeholder vars per this PR's
  // scope. Data plumbing PR will replace `buildPlaceholderVars` with
  // calls into today-meetings / priorities / upcoming-briefs.
  const triggers: ScheduledTriggerSpec[] = [
    {
      flavor: "morning",
      hourLocal: 8,
      minuteLocal: 0,
      async buildFireArgs(now: Date): Promise<FireArgs> {
        return {
          flavor: "morning",
          triggerId: buildTriggerId("morning", now),
          template: flavorToTemplate("morning"),
          vars: buildPlaceholderVars("morning", now),
        };
      },
    },
    {
      flavor: "eod",
      hourLocal: 17,
      minuteLocal: 0,
      async buildFireArgs(now: Date): Promise<FireArgs> {
        return {
          flavor: "eod",
          triggerId: buildTriggerId("eod", now),
          template: flavorToTemplate("eod"),
          vars: buildPlaceholderVars("eod", now),
        };
      },
    },
  ];

  const scheduler = createNotificationScheduler({
    dispatcher,
    logger: opts.logger.child({ component: "notification-scheduler" }),
    triggers,
    preMeeting: {
      async fetchEvents() {
        // Placeholder — calendar-source hookup lands in the data
        // plumbing PR.
        return [];
      },
      async buildFireArgs(event, now) {
        return {
          flavor: "pre-meeting",
          triggerId: `pre-meeting:${event.id}`,
          template: flavorToTemplate("pre-meeting"),
          vars: buildPlaceholderVars("pre-meeting", now),
        };
      },
      leadMinutes: 30,
      scanIntervalMs: 60_000,
    },
  });

  await scheduler.start();
  opts.logger.info("notification.bootstrap.started", {
    triggers: triggers.length,
  });

  return {
    scheduler,
    async stop(): Promise<void> {
      await scheduler.stop();
      idempotency.close();
    },
  };
}
