# SOC 2 Type 2 Compliance Status

> Honest, public-facing. Do not overstate readiness. Auditors and customers read this.

## Current Status

**SOC 2 Type 2 audit in progress.**
Target attestation: Q3/Q4 2026.

We are in the observation period — controls are running; the CPA firm will issue the Type 2 report after a 6-month window.

For Self-Hosted customers: your deployment runs entirely inside your network. Your existing SOC 2 boundary covers cortex while we complete ours.

---

## Audit Scope

The SOC 2 audit covers the **przm cortex Cloud Business** deployment:

| In scope | Out of scope |
|---|---|
| cortex SaaS Cloud (US-East, prod) | OSS / self-hosted distribution |
| przm-access service (identity + billing) | Personal Droplet deployments |
| Neon Postgres (prod database) | APAC / EU regions (separate tracks) |
| Caddy reverse proxy (TLS termination) | ISO 27001, HITRUST, FedRAMP |

---

## Compliance Platform

**Selected: [TODO — Vanta or Drata, see decision below]**

### Vanta vs. Drata Decision

| Criterion | Vanta | Drata |
|---|---|---|
| Price (est.) | $7K–12K/yr | $10K–15K/yr |
| GitHub scanning | Yes | Yes |
| DO / Neon integrations | Yes (via AWS + manual) | Yes |
| Partner CPA network | Prescient Assurance, A-LIGN | Prescient Assurance, Sensiba |
| UI maturity | Strong | Strong |
| Early-stage fit | Strong | Strong |

**Recommended: Vanta** — slightly lower price point, strong GitHub + cloud integrations, and a larger partner CPA roster for early-stage SaaS. Drata is equally credible; either works.

**TODO (operator):**
- [ ] Sign up for Vanta at https://www.vanta.com/ (or Drata if preferred)
- [ ] Complete the readiness self-assessment inside the platform
- [ ] Connect GitHub org, DigitalOcean account, Neon (as Postgres), Google Workspace

---

## CPA Firm

**Shortlist:**
- **Prescient Assurance** — most common for early-stage SaaS, Vanta + Drata partner
- **A-LIGN** — broader, slightly slower, good mid-market reputation
- **Sensiba** — West-coast focus, Drata partner, good pricing

**Recommended: Prescient Assurance** — fastest turnaround for seed/Series A SaaS, reasonable Type 1 pricing ($15K–20K), Vanta native integration.

**TODO (operator):**
- [ ] Request quotes from Prescient Assurance + A-LIGN
- [ ] Schedule Type 1 audit kickoff call (target: Month 3 = ~2026-08-28)
- [ ] Schedule Type 2 observation window end (target: ~2027-02-28 for Q1 2027 report)

---

## Audit Timeline

| Milestone | Target date | Status |
|---|---|---|
| Compliance platform signed up | 2026-06-15 | TODO |
| Readiness self-assessment complete | 2026-06-30 | TODO |
| All control gaps closed | 2026-08-01 | TODO |
| Type 1 audit (point-in-time) | 2026-08-28 | TODO |
| Type 2 observation period start | 2026-09-01 | TODO |
| Type 2 observation period end | 2027-03-01 | TODO |
| Type 2 audit fieldwork | 2027-03-15 | TODO |
| Attestation report issued | 2027-04-30 | TODO |

---

## Technical Controls

These are the controls the SOC 2 Security trust service criteria require. Status reflects current state as of 2026-05-28.

| Control | Required by | Status | Notes |
|---|---|---|---|
| SSO + MFA on admin accounts | CC6.1 | TODO | Google Workspace SSO; hardware key (YubiKey) required |
| Centralized logging | CC7.2 | TODO | Pick Datadog / Grafana Loki / CloudWatch |
| Backup + recovery test (quarterly) | A1.2 | Partial | Neon PITR enabled; runbook pending |
| Encryption at rest | CC6.7 | Done | Neon default AES-256 |
| Encryption in transit | CC6.7 | Done | Caddy TLS on all endpoints |
| Vulnerability scanning | CC7.1 | TODO | Enable via Vanta GitHub scanner |
| Incident response runbook | CC7.3 | Done | See [INCIDENT-RESPONSE.md](./runbooks/INCIDENT-RESPONSE.md) |
| Change management (PR review + audit log) | CC8.1 | Done | GitHub branch protection; audit log in przm-access |
| Access reviews (quarterly) | CC6.2 | TODO | Procedure in [ACCESS-REVIEW.md](./runbooks/ACCESS-REVIEW.md) |
| Documented backup + DR | A1.2 | Done | See [BACKUP-RESTORE.md](./runbooks/BACKUP-RESTORE.md) |

---

## Sub-processors

The following sub-processors handle customer data in the Cloud deployment:

| Sub-processor | Role | Region | DPA link |
|---|---|---|---|
| DigitalOcean | Compute + object storage | US-East (NYC3) | https://www.digitalocean.com/legal/data-processing-agreement |
| Neon | Postgres database | AWS us-east-1 | https://neon.tech/dpa |
| Resend | Transactional email | US | https://resend.com/dpa |
| Stripe | Payment processing | US | https://stripe.com/legal/dpa |
| OpenAI / Anthropic | LLM inference (optional) | US | Per-vendor DPA required |

---

## Contact

Security inquiries: security@onenomad.com
Compliance questions: hello@mattstvartak.com
