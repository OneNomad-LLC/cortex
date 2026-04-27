import { homedir } from "node:os";
import { join } from "node:path";
import {
  createNotificationDispatcher,
  openIdempotencyStore,
  type NotificationTransport,
  type FireArgs,
} from "@onenomad/cortex-pipeline-notification";
import { SlackClient } from "@onenomad/cortex-adapter-slack";
import { createLogger } from "../logger.js";
import {
  buildPlaceholderVars,
  buildTriggerId,
  flavorToTemplate,
  parseNotifyArgs,
} from "./notify-args.js";

/**
 * `cortex notify <flavor> [--dry-run]` — manually fire a notification
 * trigger. Foundation for Prong B: the cron scheduler integration is
 * a follow-up PR that simply calls this same dispatcher path on the
 * 8am/T-30/5pm hooks. Until then, operators trigger by hand to test
 * formatting + Slack auth + idempotency.
 *
 * Token resolution: `SLACK_TOKEN` env (matches the slack adapter's
 * existing convention).
 *
 * Idempotency DB: `~/.cortex/notifications.db` (sibling of
 * dashboard-cache.db).
 *
 * Channel resolution: `--channel=<id|@user>` flag overrides; default
 * `@self` (Slack treats this as a DM to the bot owner).
 */

class SlackTransport implements NotificationTransport {
  constructor(private readonly client: SlackClient) {}
  async send(args: { channel: string; message: string }): Promise<{ ok: boolean; detail?: string }> {
    const res = await this.client.postMessage({
      channel: args.channel,
      text: args.message,
    });
    if (res.ok) return { ok: true };
    return { ok: false, detail: res.error ?? "unknown" };
  }
}

export async function runNotifyCli(argv: readonly string[]): Promise<number> {
  const parsed = parseNotifyArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  const logger = createLogger({ component: "notify" });
  const now = new Date();

  // Build the dispatcher even on dry-run so the rendering code path
  // gets exercised. Transport is built but never invoked when dry-run.
  const token = process.env.SLACK_TOKEN ?? "";
  const transport: NotificationTransport = parsed.dryRun
    ? {
        async send() {
          // dry-run never reaches the transport — see dispatcher.fire
          return { ok: true };
        },
      }
    : new SlackTransport(new SlackClient({ token }));

  const idempotencyPath = join(homedir(), ".cortex", "notifications.db");
  const idempotency = openIdempotencyStore(idempotencyPath);

  const dispatcher = createNotificationDispatcher({
    transport,
    idempotency,
    logger,
    channel: parsed.channel,
    now: () => now,
  });

  const fireArgs: FireArgs = {
    flavor: parsed.flavor,
    triggerId: buildTriggerId(parsed.flavor, now),
    template: flavorToTemplate(parsed.flavor),
    vars: buildPlaceholderVars(parsed.flavor, now),
    dryRun: parsed.dryRun,
  };

  try {
    const result = await dispatcher.fire(fireArgs);
    process.stdout.write(`status: ${result.status}\n`);
    process.stdout.write(`triggerId: ${result.triggerId}\n`);
    process.stdout.write(`firedAt: ${result.firedAt}\n`);
    if (result.detail) process.stdout.write(`detail: ${result.detail}\n`);
    if (parsed.dryRun) {
      process.stdout.write(`\n--- rendered message ---\n${result.message}\n`);
    }
    return result.status === "transport_failed" ? 1 : 0;
  } finally {
    idempotency.close();
  }
}
