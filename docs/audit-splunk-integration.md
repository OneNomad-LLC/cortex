# Ingesting przm-access Audit Events into Splunk

This guide walks through configuring a przm-access audit webhook to deliver
events into your Splunk deployment using the Splunk HTTP Event Collector (HEC).

## Prerequisites

- Splunk Cloud or Splunk Enterprise with HTTP Event Collector enabled
- A HEC token with an appropriate index assigned
- `PRZM_ACCESS_ADMIN_API_KEY` and your org's UUID from the przm-access admin API
- `curl` (for setup steps) or any HTTP client

---

## Step 1 — Enable and configure Splunk HEC

### Splunk Cloud

1. Go to **Settings > Data Inputs > HTTP Event Collector**.
2. Click **New Token** and configure:
   - **Source type**: `_json`
   - **Index**: e.g. `przm_audit`
3. Copy the generated HEC token.

### Splunk Enterprise

```bash
# Enable HEC globally (if not already enabled)
splunk enable listen 8088 -auth admin:password

# Create a token
splunk add http-event-collector przm-audit \
  -index przm_audit \
  -sourcetype _json \
  -auth admin:password
```

---

## Step 2 — Register the webhook with przm-access

```bash
curl -X POST https://your-przm-access-host/admin/orgs/<ORG_ID>/audit-webhooks \
  -H "Authorization: Bearer $PRZM_ACCESS_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-adapter-host/przm-to-splunk"
  }'
```

Save the `id` (webhook ID) and `secret` from the response. The secret is
only returned on creation — store it in a secrets manager.

---

## Step 3 — Deploy the adapter

Splunk HEC expects events wrapped in a specific envelope. The adapter
verifies the przm-access HMAC signature, then forwards to HEC:

```typescript
// adapter.ts — minimal Node/Hono example
import { createHmac, timingSafeEqual } from "node:crypto";

const PRZM_SECRET = process.env.PRZM_WEBHOOK_SECRET!;
const SPLUNK_HEC  = process.env.SPLUNK_HEC_URL!;      // e.g. https://splunk.corp/services/collector/event
const SPLUNK_TOKEN = process.env.SPLUNK_HEC_TOKEN!;

function verify(body: string, header: string): boolean {
  const expected = "sha256=" + createHmac("sha256", PRZM_SECRET)
    .update(body, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header ?? "", "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handleWebhook(req: Request): Promise<Response> {
  const body = await req.text();
  const sig  = req.headers.get("x-przm-signature") ?? "";

  if (!verify(body, sig)) {
    return new Response("Forbidden", { status: 403 });
  }

  const event = JSON.parse(body);

  // Splunk HEC envelope.
  const hecPayload = {
    time:       new Date(event.occurred_at).getTime() / 1000,
    sourcetype: "przm:audit",
    source:     "przm-access",
    index:      "przm_audit",
    event,
  };

  const res = await fetch(SPLUNK_HEC, {
    method:  "POST",
    headers: {
      "Authorization": `Splunk ${SPLUNK_TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(hecPayload),
  });

  if (!res.ok) {
    console.error("Splunk HEC error:", await res.text());
    return new Response("Upstream error", { status: 502 });
  }

  return new Response("OK", { status: 200 });
}
```

Environment variables required for the adapter:

| Variable | Description |
|---|---|
| `PRZM_WEBHOOK_SECRET` | The `secret` returned when registering the webhook |
| `SPLUNK_HEC_URL` | Full HEC endpoint URL including `/services/collector/event` |
| `SPLUNK_HEC_TOKEN` | HEC token value |

---

## Step 4 — Fire a test event

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

In Splunk, search for the test event:

```splunk
index=przm_audit sourcetype="przm:audit" action=webhook.test
| table _time, action, organization_id, actor.type, target
```

---

## Step 5 — Build Splunk searches and alerts

### Common searches

**All membership changes in the last 7 days:**
```splunk
index=przm_audit sourcetype="przm:audit" action=membership.*
| eval actor=coalesce('actor.user_id', actor.type)
| table _time, action, actor, target, metadata.role
| sort -_time
```

**Token issuance rate by org (anomaly detection):**
```splunk
index=przm_audit sourcetype="przm:audit" action=token.issued
| timechart span=1h count by organization_id
```

**All events for a specific user:**
```splunk
index=przm_audit sourcetype="przm:audit" actor.user_id="<USER_UUID>"
| table _time, action, target, metadata
| sort -_time
```

### Setting up alerts

1. Run a search for the pattern you want to alert on (e.g. `action=membership.removed`).
2. Click **Save As > Alert**.
3. Configure:
   - **Trigger**: Real-time or scheduled
   - **Action**: Email, webhook, PagerDuty, etc.
4. Click **Save**.

---

## Failure recovery

przm-access retries failed deliveries with exponential backoff for up to
24 hours. After that, events are marked `failed` but remain in the database
and can be re-pulled:

```bash
# Pull all events since a timestamp
curl "https://your-przm-access-host/admin/orgs/<ORG_ID>/audit?since=2026-05-28T00:00:00Z" \
  -H "Authorization: Bearer $PRZM_ACCESS_ADMIN_API_KEY"
```

Iterate with `nextCursor` until `nextCursor` is `null`. For each page,
POST the events directly to Splunk HEC using the same adapter envelope.

### Bulk re-ingest script

```bash
#!/usr/bin/env bash
ORG_ID="your-org-uuid"
SINCE="2026-05-01T00:00:00Z"
CURSOR=""

while true; do
  URL="https://your-przm-access-host/admin/orgs/${ORG_ID}/audit?since=${SINCE}&limit=100"
  if [ -n "$CURSOR" ]; then
    URL="${URL}&cursor=${CURSOR}"
  fi

  RESP=$(curl -s -H "Authorization: Bearer $PRZM_ACCESS_ADMIN_API_KEY" "$URL")
  CURSOR=$(echo "$RESP" | jq -r '.nextCursor // empty')

  # Forward events to Splunk HEC (one per call for simplicity).
  echo "$RESP" | jq -c '.events[]' | while read -r event; do
    curl -s -X POST "$SPLUNK_HEC_URL" \
      -H "Authorization: Splunk $SPLUNK_HEC_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"sourcetype\":\"przm:audit\",\"index\":\"przm_audit\",\"event\":$event}"
  done

  if [ -z "$CURSOR" ]; then
    echo "Re-ingest complete."
    break
  fi
done
```

---

## Event schema reference

See [przm-access AUDIT-SCHEMA.md](https://github.com/OneNomad-LLC/przm-access/blob/main/apps/service/docs/AUDIT-SCHEMA.md)
for the full field reference, action enum, and versioning policy.
