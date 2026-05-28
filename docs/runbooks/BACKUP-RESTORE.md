# Backup and Restore Runbook

> DR test cadence and restore procedure. SOC 2 A1.2 control evidence.
> A restore test must be completed and logged **quarterly**.
> Last reviewed: 2026-05-28.

---

## 1. Scope

| Asset | Backup mechanism | RPO | RTO |
|---|---|---|---|
| Production Postgres (Neon) | Neon PITR — continuous WAL | < 5 minutes | < 30 minutes |
| Application config / secrets | DigitalOcean Spaces (encrypted) | 24 hours | < 1 hour |
| Embeddings / vector index | Neon pgvector — covered by PITR | < 5 minutes | < 30 minutes |
| Object storage (Spaces blobs) | DO Spaces versioning | 24 hours | < 2 hours |
| Droplet / compute | DO Droplet snapshots (weekly) | 7 days | < 1 hour |

---

## 2. Neon PITR — How It Works

Neon keeps a continuous WAL archive for the retention window (currently **7 days** on the paid plan). You can restore to any point in time within that window.

**Key facts for the auditor:**
- Encryption at rest: AES-256 (Neon default, AWS us-east-1).
- Backups are automated — no manual trigger required.
- Retention window: 7 days (paid plan). Upgrade to 30-day retention before Type 1 audit.

---

## 3. Restore Procedure

### 3.1 Neon PITR restore (database)

**Use this for:** Accidental data deletion, corrupted rows, ransomware, breach isolation.

```bash
# 1. Identify the target point-in-time (UTC)
TARGET_TIME="2026-05-28T10:00:00Z"

# 2. Create a restore branch in Neon dashboard
# Dashboard → Branches → Create branch → "Restore to point in time" → enter $TARGET_TIME
# This is NON-DESTRUCTIVE — it creates a new branch, not an in-place restore.

# 3. Verify the restored branch contains the expected data
psql "$RESTORE_BRANCH_URL" -c "SELECT COUNT(*) FROM tenants;"
psql "$RESTORE_BRANCH_URL" -c "SELECT MAX(created_at) FROM audit_log;"

# 4. If verified, promote the restore branch to primary:
# Dashboard → Branch → Set as primary (or update DATABASE_URL in prod env)

# 5. Update the cortex deployment's DATABASE_URL env var if the connection string changed:
# fly secrets set DATABASE_URL="<new-branch-url>" --app cortex-prod
# (or DigitalOcean App Platform environment variable panel)

# 6. Restart the application to pick up the new connection
fly app restart cortex-prod
```

**Estimated time to restore service:** 20–30 minutes.

### 3.2 Droplet snapshot restore (compute)

**Use this for:** Corrupted OS, compromised Droplet, infrastructure failure.

```bash
# 1. List available snapshots
doctl compute snapshot list --resource droplet

# 2. Create a new Droplet from the snapshot
doctl compute droplet create cortex-restore \
  --snapshot-id <snapshot-id> \
  --region nyc3 \
  --size s-4vcpu-8gb \
  --ssh-keys <your-key-fingerprint>

# 3. Update DNS (Cloudflare) to point to new Droplet IP
# Cloudflare dashboard → DNS → update A record for cortex.przm.sh

# 4. Verify TLS and service health
curl -s https://cortex.przm.sh/health

# 5. Decommission old Droplet once confirmed healthy
doctl compute droplet delete <old-droplet-id>
```

**Estimated time to restore service:** 30–60 minutes (DNS propagation is the long pole).

### 3.3 Config / secrets restore

**Use this for:** Lost environment variables, rotated secrets needed.

```bash
# Secrets are stored in:
# - Fly.io secrets (fly secrets list --app cortex-prod)
# - DigitalOcean App Platform environment variables
# - Local encrypted backup in DO Spaces: s3://onenomad-backups/secrets/

# Restore from Spaces backup:
doctl spaces get onenomad-backups/secrets/env-backup-YYYY-MM-DD.enc > env.enc
gpg --decrypt env.enc > env.txt
# Review, then re-apply secrets per platform

# TODO: document the GPG key ID used for backup encryption
# TODO: store the decryption key in a password manager (1Password recommended)
```

---

## 4. Quarterly DR Test Procedure

SOC 2 requires documented evidence that backups are **tested**, not just taken.

**Estimated time per test: 60–90 minutes.**

### Pre-test checklist

- [ ] Notify team: test restore in progress (avoids false alarms)
- [ ] Confirm test will use a **non-production branch** — never restore over prod
- [ ] Identify the test point-in-time (choose a timestamp from last 48 hours)

### Test steps

1. **Neon PITR test:**
   - Create a restore branch to the chosen timestamp
   - Run validation queries (see 3.1 step 3)
   - Confirm row counts and `MAX(created_at)` match expected
   - Delete the test branch when done

2. **Droplet snapshot test:**
   - Create a test Droplet from the most recent weekly snapshot
   - Run smoke test: `curl http://<test-droplet-ip>:3000/health`
   - Confirm application starts and connects to the test DB
   - Destroy the test Droplet

3. **Config restore test:**
   - Decrypt the latest `env-backup-*.enc` from Spaces
   - Verify all expected keys are present
   - Do NOT apply to prod; just verify the file is valid

### Post-test

- [ ] Fill in the DR Test Log below
- [ ] Fix any failures before the next review cycle

---

## 5. DR Test Log

| Test date | Tester | Neon PITR result | Snapshot result | Config result | Notes |
|---|---|---|---|---|---|
| 2026-05-28 | Matt Stvartak | TODO — first test pending | TODO | TODO | Initial runbook; test to be completed |
| TODO Q3 2026 | | | | | |
| TODO Q4 2026 | | | | | |
| TODO Q1 2027 | | | | | |

---

## 6. Backup Configuration Checklist

Verify these settings are in place before the Type 1 audit:

- [ ] Neon PITR retention window: ≥ 30 days (upgrade from 7-day default)
- [ ] DO Droplet snapshots: weekly schedule enabled (`doctl compute droplet-action schedule-snapshot`)
- [ ] DO Spaces versioning: enabled on `onenomad-backups` bucket
- [ ] Secrets backup: automated weekly export to `onenomad-backups/secrets/` (TODO: wire cron job)
- [ ] Backup encryption: GPG key documented in 1Password

---

## 7. Review Cadence

This runbook is reviewed **quarterly** alongside the DR test.

| Quarter | Test due |
|---|---|
| Q2 2026 | 2026-06-30 (complete the TODO above) |
| Q3 2026 | 2026-09-30 |
| Q4 2026 | 2026-12-31 |
| Q1 2027 | 2027-03-31 |
