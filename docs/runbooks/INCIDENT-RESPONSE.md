# Incident Response Runbook

> This document is part of the SOC 2 Type 2 audit evidence package.
> Auditors: this is the operational procedure the team follows for all security incidents.
> Last reviewed: 2026-05-28.

---

## 1. Scope

This runbook covers **security incidents** affecting the przm cortex Cloud Business deployment:

- Unauthorized access to customer data or admin systems
- Suspected credential compromise (service accounts, API keys, admin passwords)
- Data breach or exfiltration (confirmed or suspected)
- DDoS or availability impacting incidents where security is the root cause
- Dependency vulnerability requiring emergency patching (CVSS ≥ 9.0)

**Out of scope:** General outages with no security component (handled by on-call ops rotation).

---

## 2. Severity Definitions

| Severity | Definition | Example | Response SLA |
|---|---|---|---|
| **P0 — Critical** | Active breach or confirmed data exfiltration | DB credentials leaked to public | Immediate (< 15 min) |
| **P1 — High** | Suspected breach; admin access compromised | Unusual admin login from unknown IP | < 1 hour |
| **P2 — Medium** | Potential exposure; no confirmed breach | Dependency CVE ≥ 9.0; misconfiguration found | < 4 hours |
| **P3 — Low** | Minor or theoretical risk | CVE 7.x with no exploit; config drift | < 24 hours |

---

## 3. Detection Sources

Incidents may be detected via:

- [ ] **Vanta / Drata alerts** — compliance platform scanning GitHub, cloud accounts
- [ ] **TODO:** Centralized log anomaly alert (Datadog / Grafana Loki — to be configured)
- [ ] **TODO:** DigitalOcean monitoring alerts (CPU/network spikes)
- [ ] **GitHub Dependabot / security advisories** — dependency CVE notifications
- [ ] **External report** — customer, researcher, or HackerOne disclosure (see SECURITY.md)
- [ ] **Internal discovery** — engineer notices anomaly during normal work

---

## 4. Response Procedure

### 4.1 Triage (all severities)

1. **Confirm the report is real.** Do not act on unverified reports.
2. **Assign an Incident Commander (IC).** Default: Matt Stvartak. Backup: [TODO — designate backup].
3. **Open an incident channel.** Create `#incident-YYYY-MM-DD` in Slack (or equivalent).
4. **Set severity.** Use the table above.
5. **Start the incident log.** Timestamped entries in the channel. Every action logged.

### 4.2 Containment (P0/P1)

**Do these in order. Speed matters more than process at this stage.**

1. **Revoke compromised credentials immediately.**
   - GitHub: Settings → Developer settings → Personal access tokens → Revoke
   - DigitalOcean: API → Tokens → Delete
   - Neon: Settings → API keys → Revoke
   - Google Workspace: Admin console → Users → Reset password + force MFA re-enroll

2. **Isolate affected systems if breach is active.**
   - DigitalOcean: Firewall → drop all inbound except known-good IPs
   - TODO: define "known-good" CIDR list

3. **Preserve evidence before wiping.**
   - Snapshot the Droplet: `doctl compute droplet-action snapshot <droplet-id>`
   - Export Neon WAL for the affected time window (Neon dashboard → Branches → Download)
   - Copy application logs to a separate S3/Space bucket

4. **Notify affected tenants** (if customer data is involved). See Section 6.

### 4.3 Eradication

1. **Root cause analysis.** What allowed the breach? Document in incident log.
2. **Remove attacker persistence** (backdoors, added SSH keys, rogue OAuth apps).
3. **Patch or rotate everything touched.**
4. **Re-run Vanta / Drata scan** to confirm controls are back in place.

### 4.4 Recovery

1. **Restore service from last known-good state.** Prefer Neon PITR over manual restores.
2. **Re-enable firewall rules** only after eradication is confirmed.
3. **Monitor closely for 24 hours** post-recovery.
4. **TODO:** Define rollback procedure for Caddy + Fly.io deployments.

### 4.5 Post-Incident Review

- Schedule within **5 business days** of resolution.
- Produce a written post-mortem: timeline, root cause, impact, action items.
- File post-mortem in `/docs/security/post-mortems/YYYY-MM-DD-<slug>.md`.
- Present action items to close any control gap found.

---

## 5. Communication

### Internal

- IC posts all updates to `#incident-YYYY-MM-DD` channel.
- No speculation outside the channel until root cause is confirmed.
- Brief the team at 30-min intervals on P0/P1.

### Customer Notification (if data affected)

**Trigger:** Any confirmed or reasonably suspected access to customer data.

**Timeline:**
- **Within 24 hours:** notify affected tenants via email (from hello@mattstvartak.com or security@onenomad.com).
- **Within 72 hours:** notify affected tenants' DPOs if EU data is involved (GDPR Art. 33/34 — even though EU region isn't live yet, US tenants with EU data may require this).

**Notification template:**

```
Subject: Security Notice — [Date] Incident

We are writing to notify you of a security incident that may have affected your data on przm cortex Cloud.

What happened: [one-sentence factual description]
When it happened: [date/time range]
What data was involved: [types, not contents]
What we've done: [containment actions taken]
What you should do: [any user action required — rotate API keys, etc.]

We are continuing to investigate and will provide updates as they become available.

Contact: security@onenomad.com
```

### Regulatory (if required)

- **GDPR (EU data):** notify relevant supervisory authority within 72 hours of confirmed breach.
- **TODO:** Identify which authority based on tenant location (BfDI for Germany; ICO for UK).
- **CCPA:** notify California AG if > 500 CA residents affected.

---

## 6. Evidence Preservation Checklist

For P0/P1 incidents, preserve before any cleanup:

- [ ] Application logs (Fly.io / DigitalOcean) for the affected window
- [ ] Neon query logs (if available)
- [ ] Cloudflare / Caddy access logs
- [ ] GitHub audit log export for the affected period
- [ ] przm-access audit log export (see `/docs/audit-datadog-integration.md`)
- [ ] Droplet snapshot

---

## 7. Contacts

| Role | Name | Contact |
|---|---|---|
| Incident Commander (primary) | Matt Stvartak | hello@mattstvartak.com |
| Incident Commander (backup) | TODO | TODO |
| Legal / DPA counsel | TODO | TODO |
| CPA firm (SOC2 auditor) | TODO — to be selected | TODO |
| Compliance platform support | Vanta / Drata | via platform portal |

---

## 8. Review Cadence

This runbook is reviewed **quarterly** and after every P0/P1 incident.

Next review: 2026-08-28.

| Date | Reviewer | Changes |
|---|---|---|
| 2026-05-28 | Matt Stvartak | Initial draft |
