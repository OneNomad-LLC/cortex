# przm Cortex — Service Level Agreement Template

> **OPERATOR NOTE:** This is a template. Before issuing to a customer, fill
> in all `[BRACKETED]` placeholders, have legal review the final document, and
> version-control the signed copy alongside this file.

---

## 1. Parties

This Service Level Agreement ("SLA") is entered into between:

- **Service Provider:** [OPERATOR LEGAL NAME] ("Provider"), and
- **Customer:** [CUSTOMER LEGAL NAME] ("Customer"),

effective as of [EFFECTIVE DATE] ("Effective Date").

---

## 2. Definitions

| Term | Definition |
|---|---|
| **Service** | The przm Cortex MCP server and associated API endpoints operated by Provider at [SERVICE URL]. |
| **Monthly Uptime Percentage** | The fraction of minutes in a calendar month during which the Service is Available, excluding Scheduled Maintenance and Excluded Events. |
| **Available** | The Service responds to authenticated MCP `initialize` requests within the Latency SLA window. |
| **Scheduled Maintenance** | Planned downtime announced via the status page at least 24 hours in advance. Limited to 4 hours per calendar month. |
| **Service Credit** | A percentage reduction applied to the next invoice period's recurring fees. |
| **p95 Latency** | The 95th-percentile MCP tool-call round-trip duration measured at the server boundary, expressed in milliseconds. |

---

## 3. Uptime Commitment

Provider will use commercially reasonable efforts to maintain:

| Metric | Target |
|---|---|
| Monthly Uptime Percentage | **≥ 99.9%** (≤ 43.8 minutes downtime/month) |
| p95 MCP tool-call latency | **≤ 200 ms** under normal load |
| p99 MCP tool-call latency | **≤ 500 ms** under normal load |

> **Note for legal review:** The 200 ms p95 target is derived from the
> product brief. Verify against current infrastructure benchmarks before
> signing. Some tool calls (e.g. `ingest_url`, `ingest_repo`) involve
> network I/O and are explicitly excluded from the latency SLA — see §5.

Uptime is measured using synthetic probes against the `/health` endpoint
every 60 seconds from at least two geographic locations. The monthly
percentage is computed as:

```
Uptime% = (total_minutes - downtime_minutes) / total_minutes × 100
```

---

## 4. Service Credits

If Provider fails to meet the Monthly Uptime Percentage commitment,
Customer is eligible for the following Service Credits:

| Monthly Uptime | Credit |
|---|---|
| 99.0% – 99.9% | 10% of monthly fee |
| 95.0% – 99.0% | 25% of monthly fee |
| < 95.0% | 50% of monthly fee |

Service Credits are Customer's sole and exclusive remedy for any failure by
Provider to meet the Monthly Uptime Percentage.

**To claim a credit:** Customer must submit a written request within 30 days
of the end of the affected calendar month, including the dates and times of
the downtime events. Provider will validate against internal telemetry and
respond within 10 business days.

Credits are not transferable, cannot be exchanged for cash, and may not
exceed the total fees paid in the affected month.

---

## 5. Exclusions

The following are excluded from Uptime and Latency SLA calculations:

1. **Scheduled Maintenance** announced ≥ 24 hours in advance.
2. **Force majeure:** natural disasters, government actions, civil
   disturbances, internet exchange failures beyond Provider's upstream.
3. **Customer-side issues:** misconfigured MCP clients, network failures
   between Customer and Provider, Client-imposed rate limits, or actions
   by Customer's users.
4. **Third-party dependencies:** outages of Neon Postgres, DigitalOcean
   infrastructure, or OpenRouter LLM services.
5. **Long-running tool calls:** `ingest_url`, `ingest_repo`, `ingest_file`,
   and enrichment-protocol tools are network/compute-bound and are excluded
   from the p95/p99 latency targets. They are covered under the uptime SLA
   only (they must eventually complete, not within a time budget).
6. **Beta features:** any tool or endpoint labeled `[beta]` or `[experimental]`.

---

## 6. Latency Monitoring

Provider exposes a Prometheus-compatible scrape endpoint at `/metrics`
(Bearer-token gated) reporting:

| Metric | Description |
|---|---|
| `cortex_mcp_tool_duration_seconds` | Per-tool histogram (p50/p95/p99), labeled by `tool` and `status`. |
| `cortex_search_duration_seconds` | Semantic search latency histogram. |
| `cortex_ingest_duration_seconds` | Memory ingest latency histogram. |

Customer may optionally configure a Prometheus-compatible scraper to ingest
these metrics into their own observability stack. Provider retains metrics
internally for a minimum of 30 days for SLA validation.

---

## 7. Incident Notification

| Severity | Definition | Provider Response |
|---|---|---|
| P0 — Complete outage | Service unavailable for > 5 consecutive minutes | Acknowledgement within 15 min; updates every 30 min |
| P1 — Degraded | p95 latency > 2× SLA target or error rate > 5% | Acknowledgement within 1 hour |
| P2 — Minor | p95 latency > SLA target, error rate < 5% | Acknowledgement within 4 hours |

Incident status is posted to: **[STATUS PAGE URL]** (see
`docs/operations/STATUS-PAGE.md` for setup).

---

## 8. Data Residency

When Customer has selected the **EU** region (see tenant configuration),
all Customer data processed by the Service is stored and processed within
the European Economic Area (EEA). The primary compute region is Frankfurt
(fra1). See `legal/dpa-template.md` for the full Data Processing Agreement.

---

## 9. Term and Termination

This SLA remains in effect for the duration of the underlying service
agreement between the parties. Either party may terminate with 30 days
written notice. Credits accrued prior to termination are forfeited.

---

## 10. Amendments

Provider reserves the right to update this SLA with 30 days advance notice
posted to the status page. Continued use of the Service after the notice
period constitutes acceptance.

---

*Template version: 1.0 — 2026-05-28. Prepared by OneNomad engineering.*
*Requires legal review before customer execution.*
