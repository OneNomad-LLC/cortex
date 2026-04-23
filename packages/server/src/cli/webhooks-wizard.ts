import type { WizardModule } from "@onenomad/cortex-core";
import { z } from "zod";
import { webhooksConfigSchema, type WebhooksConfig } from "../config.js";

/**
 * Webhooks wizard — toggles the HTTP receiver cortex boots for push-based
 * adapters (GitHub, Slack Events, Linear). Off by default because binding
 * a port only makes sense when you have a way to expose it publicly
 * (Tailscale Funnel, reverse proxy, ngrok). The wizard does not try to
 * install or configure those exposure tools — it just flips the flag and
 * picks a port.
 */
export const webhooksWizard: WizardModule<WebhooksConfig> = {
  id: "webhooks",
  name: "Webhooks receiver",
  category: "webhook",
  description:
    "Bind an HTTP receiver for push-delivered adapter events. Only turn " +
    "this on after you've wired a way to expose the port publicly.",
  configSchema: webhooksConfigSchema,
  steps: [
    {
      key: "enabled",
      prompt: "Enable the webhooks HTTP receiver?",
      type: "boolean",
      defaultValue: false,
    },
    {
      key: "host",
      prompt: "Bind host (0.0.0.0 works for reverse-proxy / Funnel setups)",
      type: "text",
      defaultValue: "0.0.0.0",
    },
    {
      key: "port",
      prompt: "Bind port",
      type: "text",
      defaultValue: "4040",
      pattern: /^\d+$/,
    },
  ],
  secrets: [],
};

const coercedConfigSchema = z.preprocess((val) => {
  if (typeof val !== "object" || val === null) return val;
  const obj = { ...(val as Record<string, unknown>) };
  const p = obj.port;
  if (typeof p === "string" && p.length > 0) obj.port = Number(p);
  if (p === "" || p === undefined) delete obj.port;
  return obj;
}, webhooksConfigSchema);

(webhooksWizard as { configSchema: z.ZodTypeAny }).configSchema = coercedConfigSchema;
