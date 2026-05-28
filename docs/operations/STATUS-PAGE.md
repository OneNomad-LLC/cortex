# Status Page Setup

Cortex exposes live uptime state via `/api/status`. This runbook covers
standing up a public-facing status page that customers can bookmark.

---

## Platform Comparison: Better Stack vs. Statuspage

### Better Stack (Uptime + Status)

**Recommended** for Cortex at the current stage.

| Factor | Detail |
|---|---|
| Price | Free tier: 10 monitors, 3-min interval. Pro: ~$20/mo per seat, unlimited monitors. |
| Incident detection | HTTP(S) probes from 30+ regions; webhook-triggered incidents via API. |
| Status page | Public subdomain (`[workspace].betteruptime.com`) or custom domain, free SSL. |
| API | REST + webhooks; easy to automate incident creation from Prometheus alerts. |
| On-call routing | Included (vs. PagerDuty/OpsGenie upsell on Atlassian). |
| GitHub integration | Can open issues on incidents. |
| DO / Railway integration | No native provider, but webhook bridge is trivial. |

**Why not Statuspage (Atlassian)?**

- ~$29/mo minimum even for the starter tier with a custom domain.
- UI is dated and the API is clunkier (POST-heavy, non-RESTful in places).
- Atlassian acquisition slowed the feature roadmap noticeably.
- No built-in on-call; you pay PagerDuty separately.
- Overkill for a single-product SaaS at seed/Series A stage.

**Choose Statuspage** only if a large enterprise customer explicitly requires
it as a contractual condition (some do).

---

## Better Stack Setup (Step-by-step)

### 1. Create account and team

1. Sign up at https://betterstack.com → Uptime.
2. Create a Team named **przm Cortex Ops** (or your org name).
3. Invite any on-call engineers.

### 2. Add the Cortex health monitor

1. Dashboard → **Monitors** → **Create monitor**.
2. Settings:
   - URL: `https://<YOUR_CORTEX_HOST>/health`
   - Interval: **1 minute** (minimum on Free; 30s on Pro).
   - Expected HTTP status: `200`.
   - Regions: select US East + EU West at minimum.
3. Under **Authentication**, add:
   ```
   Authorization: Bearer <PRZM_CORTEX_API_AUTH_TOKEN>
   ```
   (The `/health` route bypasses auth by default — but if your deployment
   sets `PRZM_CORTEX_API_AUTH_TOKEN`, the bearer must be present.)
4. Save. Wait for the first check to resolve green.

### 3. Add the MCP API status monitor

Repeat step 2 with:
- URL: `https://<YOUR_CORTEX_HOST>/api/status`
- Same auth header.
- Monitor name: **Cortex MCP API**.

### 4. Create the status page

1. Dashboard → **Status pages** → **Create status page**.
2. Name: **przm Cortex Status**.
3. Subdomain: `status-przm-cortex` (or configure a custom domain, e.g.
   `status.przm.sh`).
4. Add both monitors from steps 2–3 under **Resources**.
5. Under **Branding**, upload the przm logo and set the accent color.
6. **Publish** — the page is live.

### 5. Wire Prometheus alerts into Better Stack incidents (optional)

When Grafana fires an alert (p95 > 200ms threshold):

1. In Better Stack → **On-call** → **Incoming webhooks** → copy the
   webhook URL.
2. In Grafana → **Alerting** → **Contact points** → add a Webhook contact
   pointing to the Better Stack URL.
3. Test by temporarily lowering the alert threshold.

This creates an incident on the Better Stack timeline automatically, which
posts to the status page without manual intervention.

### 6. Scheduled maintenance windows

Before a deploy or database migration:

```bash
# Create a maintenance window via the Better Stack API
curl -X POST https://uptime.betterstack.com/api/v2/maintenances \
  -H "Authorization: Bearer <BETTER_STACK_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Cortex deploy — v0.8.0",
    "start_at": "2026-06-01T02:00:00Z",
    "end_at": "2026-06-01T02:30:00Z",
    "affected_monitor_ids": [<MONITOR_ID_1>, <MONITOR_ID_2>]
  }'
```

Customers subscribed to the status page receive an email notification 24h
in advance (configurable). This keeps the scheduled window out of the
uptime SLA calculation per `legal/sla-template.md §5`.

---

## Environment variables to record

After setup, add to Railway / Fly secrets (never commit):

```
PRZM_CORTEX_BETTER_STACK_HEARTBEAT_URL=https://uptime.betterstack.com/api/v1/heartbeat/<TOKEN>
PRZM_CORTEX_BETTER_STACK_API_KEY=<KEY>
```

The heartbeat URL can be polled from the Cortex heartbeat writer to give
Better Stack a push-based liveness signal in addition to HTTP probes.

---

## Current status page URL

> TODO: fill in after initial setup — update this file and commit.

`https://[SUBDOMAIN].betteruptime.com`

---

*Last updated: 2026-05-28*
