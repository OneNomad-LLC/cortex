# Ingesting przm-access Audit Events into Datadog

This guide walks through configuring a przm-access audit webhook to deliver
events into your Datadog account using the Datadog HTTP Logs intake.

## Prerequisites

- A Datadog account with API key access
- `PRZM_ACCESS_ADMIN_API_KEY` and your org's UUID from the przm-access admin API
- `curl` (for setup steps) or any HTTP client

---

## Step 1 — Create a Datadog intake URL

Datadog accepts logs via the HTTP Logs API:

```
https://http-intake.logs.datadoghq.com/api/v2/logs
```

For EU region:
```
https://http-intake.logs.datadoghq.eu/api/v2/logs
```

You will wrap this in a small adapter (see Step 3) because Datadog's intake
expects a different payload format than the raw przm-access event.

---

## Step 2 — Register the webhook with przm-access

```bash
curl -X POST https://your-przm-access-host/admin/orgs/<ORG_ID>/audit-webhooks \
  -H "Authorization: Bearer $PRZM_ACCESS_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-adapter-host/przm-to-datadog"
  }'
```

Save the `id` (webhook ID) and `secret` from the response. The secret is
only returned on creation — store it in a secrets manager.

---

## Step 3 — Deploy the adapter

przm-access POSTs raw JSON events. Datadog expects a specific shape. The
simplest adapter is a minimal HTTP function (Lambda, Fly.io, etc.):

```typescript
// adapter.ts — minimal Hono/Node example
import { createHmac, timingSafeEqual } from "node:crypto";

const PRZM_SECRET  = process.env.PRZM_WEBHOOK_SECRET!;
const DD_API_KEY   = process.env.DD_API_KEY!;
const DD_INTAKE    = "https://http-intake.logs.datadoghq.com/api/v2/logs";

function verify(body: string, header: string): boolean {
  const expected = "sha256=" + createHmac("sha256", PRZM_SECRET)
    .update(body, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header ?? "", "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handleWebhook(req: Request): Promise<Response> {
  const body   = await req.text();
  const sig    = req.headers.get("x-przm-signature") ?? "";

  if (!verify(body, sig)) {
    return new Response("Forbidden", { status: 403 });
  }

  const event = JSON.parse(body);

  // Map to Datadog log shape.
  const ddLog = {
    ddsource:  "przm-access",
    ddtags:    `org_id:${event.organization_id},action:${event.action}`,
    hostname:  "przm-access",
    service:   "przm-access",
    message:   `[${event.action}] ${event.target ?? ""}`,
    // Preserve full event for search/facets.
    przm_event: event,
  };

  await fetch(DD_INTAKE, {
    method:  "POST",
    headers: {
      "Content-Type":   "application/json",
      "DD-API-KEY":     DD_API_KEY,
    },
    body: JSON.stringify([ddLog]),
  });

  return new Response("OK", { status: 200 });
}
```

Environment variables required for the adapter:

| Variable | Description |
|---|---|
| `PRZM_WEBHOOK_SECRET` | The `secret` returned when registering the webhook |
| `DD_API_KEY` | Datadog API key with `logs_write` permission |

---

## Step 4 — Fire a test event

Before putting real traffic through, verify end-to-end connectivity:

```bash
curl -X POST https://your-przm-access-host/admin/orgs/<ORG_ID>/audit-webhooks/<WH_ID>/test \
  -H "Authorization: Bearer $PRZM_ACCESS_ADMIN_API_KEY"
```

Expected response:
```json
{
  "eventId":    "...",
  "webhookId":  "...",
  "delivered":  true,
  "statusCode": 200,
  "error":      null
}
```

Then check the Datadog Logs explorer for an event with `ddsource:przm-access`
and `action:webhook.test`.

---

## Step 5 — Create Datadog facets and dashboards

In Datadog Log Management:

1. Navigate to **Logs > Configuration > Facets**.
2. Add facets for:
   - `@przm_event.action` — filter by audit action
   - `@przm_event.organization_id` — filter by org
   - `@przm_event.actor.user_id` — filter by actor
   - `@przm_event.tenant_id` — filter by tenant
3. Create a **Log Analytics** dashboard to monitor:
   - Event volume over time, broken down by `action`
   - Failed login attempts (`action:token.issued` anomalies)
   - Membership changes (`action:membership.*`)

---

## Failure recovery

If your adapter is down, przm-access retries with exponential backoff for up
to 24 hours. After that, events are marked `failed` but are NOT lost — they
remain in the przm-access database and can be re-pulled:

```bash
curl "https://your-przm-access-host/admin/orgs/<ORG_ID>/audit?since=2026-05-28T00:00:00Z" \
  -H "Authorization: Bearer $PRZM_ACCESS_ADMIN_API_KEY"
```

Iterate with `nextCursor` until `nextCursor` is `null`, then forward the
events to Datadog directly.

---

## Event schema reference

See [przm-access AUDIT-SCHEMA.md](https://github.com/OneNomad-LLC/przm-access/blob/main/apps/service/docs/AUDIT-SCHEMA.md)
for the full field reference, action enum, and versioning policy.
