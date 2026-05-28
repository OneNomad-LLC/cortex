# Access Review Runbook

> Quarterly procedure. SOC 2 CC6.2 control evidence.
> The auditor will ask for completed review records — fill out the log at the bottom after each review.
> Last reviewed: 2026-05-28.

---

## 1. Purpose

Ensure that access to production systems, admin accounts, and customer data is:

- **Appropriate** — each person has only the access their role requires (least privilege).
- **Current** — departures and role changes are reflected promptly.
- **Documented** — a written record exists for the auditor.

SOC 2 requires this review at least **quarterly**.

---

## 2. Scope

Systems covered in each review:

| System | Admin access path | Reviewer |
|---|---|---|
| DigitalOcean (prod Droplet, Spaces, LBs) | DO Team Members → Project | Matt Stvartak |
| Neon (prod database) | Neon org members + DB roles | Matt Stvartak |
| GitHub (OneNomad-LLC org) | Org members + repo collaborators | Matt Stvartak |
| Google Workspace (internal email, drive) | Admin console → Users | Matt Stvartak |
| Fly.io (if used) | Org members | Matt Stvartak |
| Stripe (prod account) | Team members | Matt Stvartak |
| przm-access admin API | Admin role in DB + service keys | Matt Stvartak |
| Vanta / Drata (compliance platform) | Users | Matt Stvartak |
| TODO: Centralized logging platform | Admin + viewer roles | Matt Stvartak |

---

## 3. Review Procedure

Complete this in order. Estimated time: **60–90 minutes per review.**

### 3.1 Human accounts

For each system in the scope table:

1. **Pull the current user list.**
   - DigitalOcean: Settings → Team → Members
   - GitHub: Organization → People
   - Google Workspace: Admin console → Directory → Users
   - Neon: Organization → Members
   - Stripe: Settings → Team

2. **For each user, confirm:**
   - [ ] Still employed / engaged with the project
   - [ ] Access level matches current role (no permission creep)
   - [ ] MFA is enabled (where the platform supports it)

3. **Revoke or downgrade any account that fails the check.** Document the action in the review log below.

### 3.2 Service accounts and API keys

1. **GitHub:** Settings → Developer settings → OAuth Apps + GitHub Apps → review connected apps
2. **DigitalOcean:** API → Tokens → list all tokens → revoke any unused or unknown
3. **Neon:** Settings → API keys → revoke unused
4. **Stripe:** Developers → API keys → list restricted keys → revoke unused
5. **przm-access:** `SELECT name, created_at, last_used_at FROM service_keys ORDER BY last_used_at ASC;` — revoke keys not used in > 90 days

### 3.3 Database roles

```sql
-- Run against prod Neon
SELECT usename, usesuper, usecreatedb, usecreaterole
FROM pg_catalog.pg_user
ORDER BY usename;
```

Confirm:
- [ ] Only the application service account has `CONNECT` to the prod DB
- [ ] No personal developer accounts have direct prod DB access
- [ ] No `usesuper` accounts exist beyond the platform default

### 3.4 SSH / Droplet access

```bash
# On prod Droplet
cat /root/.ssh/authorized_keys
cat /home/*/.ssh/authorized_keys 2>/dev/null
```

Confirm:
- [ ] Only current team members' keys are present
- [ ] No unknown keys

### 3.5 Admin API scope

Review the przm-access admin role assignments:

```sql
-- Run against prod przm-access DB
SELECT u.email, m.role, m.created_at
FROM org_members m
JOIN users u ON u.id = m.user_id
WHERE m.role IN ('owner', 'admin')
ORDER BY m.created_at;
```

Confirm:
- [ ] Owner / admin count is minimal
- [ ] All listed admins are active

---

## 4. Offboarding Checklist

When a team member or contractor departs, complete within **24 hours**:

- [ ] Revoke GitHub org membership
- [ ] Remove from DigitalOcean team
- [ ] Suspend Google Workspace account (keep mailbox for 30 days, then delete)
- [ ] Remove from Neon org
- [ ] Revoke all personal API keys (GitHub PAT, DO tokens)
- [ ] Remove SSH key from prod Droplet
- [ ] Remove from Stripe team
- [ ] Remove from Vanta / Drata
- [ ] Remove from any Slack / comms workspace with prod credentials
- [ ] Document in the review log below with the departure date

---

## 5. Review Log

Fill in after each quarterly review. This is the evidence the auditor sees.

| Review date | Reviewer | Systems reviewed | Findings | Actions taken | Sign-off |
|---|---|---|---|---|---|
| 2026-05-28 | Matt Stvartak | All (initial) | No issues — single-operator, controls validated | None required | MS |
| TODO Q3 2026 | | | | | |
| TODO Q4 2026 | | | | | |
| TODO Q1 2027 | | | | | |

---

## 6. Review Cadence

| Quarter | Due date |
|---|---|
| Q2 2026 | 2026-05-28 (this review) |
| Q3 2026 | 2026-08-28 |
| Q4 2026 | 2026-11-28 |
| Q1 2027 | 2027-02-28 |
