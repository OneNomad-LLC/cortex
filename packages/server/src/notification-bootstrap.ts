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
import { buildTriggerId, flavorToTemplate } from "./cli/notify-args.js";
import { buildVarsForFlavor } from "./notification-data.js";
import type { WidgetContext } from "./api/types.js";

/**
 * Bootstrap the notification scheduler at server startup. Returns a
 * stoppable handle. No-op (returns null) when SLACK_TOKEN is absent —
 * server boot shouldn't fail just because Slack isn't wired yet.
 *
 * What's plumbed:
 *   - 8am morning + 5pm eod daily fire with real data (today-meetings,
 *     priorities, my-action-items handlers)
 *   - pre-meeting hook is wired but uses placeholder vars + an empty
 *     `fetchEvents`; calendar-source wiring lands in a follow-up
 *
 * What's deferred:
 *   - Pre-meeting per-event vars (needs upcoming-briefs single-event
 *     query + calendar-source events feed)
 *   - notifications.yaml per-workspace config (channel + per-trigger
 *     enable/disable)
 *   - Overnight signals in the morning brief
 */
export interface NotificationBootstrapOptions {
  logger: Logger;
  /** Widget context — the data builders call widget handlers via this. */
  widgetContext: WidgetContext;
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

  const dataCtx = {
    ctx: opts.widgetContext,
    logger: opts.logger.child({ component: "notification-data" }),
  };

  // 8am morning + 5pm eod, with real data pulled from the dashboard
  // widget handlers via the data-builder. A handler failure degrades
  // to a partial brief rather than skipping the fire entirely.
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
          vars: await buildVarsForFlavor("morning", dataCtx, now),
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
          vars: await buildVarsForFlavor("eod", dataCtx, now),
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
        // Placeholder — calendar-source hookup is a follow-up. Returns
        // empty so the scheduler runs but never fires a pre-meeting.
        return [];
      },
      async buildFireArgs(event, now) {
        return {
          flavor: "pre-meeting",
          triggerId: `pre-meeting:${event.id}`,
          template: flavorToTemplate("pre-meeting"),
          vars: await buildVarsForFlavor("pre-meeting", dataCtx, now),
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
