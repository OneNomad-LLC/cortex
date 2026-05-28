# OSS / Cloud feature parity

> Every feature documented in the user-facing docs runs on a free OSS install
> with no license configured. The license key gates **support entitlement,
> telemetry consent, and SLA enforcement** — not features.

## The contract

Cortex is open-core. The line between "what's free" and "what's paid" is
**operational, not functional.**

What an OSS install (`git clone` → `docker compose up`) gives you:

- RLS-enforced multi-tenancy (the same Postgres rows you'd get on Cloud)
- Every source adapter — Confluence, Bitbucket, Notion, Jira, Linear, Loom,
  Obsidian, Slack, GitHub
- The hybrid retrieval pipeline (BM25 + vector + RRF + cross-encoder rerank)
- The admin dashboard and its CRUD surface
- The access service's token issuance and verification
- Every MCP tool the server exposes
- Multi-tenant, multi-project, multi-user isolation

What the EdDSA-signed license key buys (Self-Hosted Enterprise customers):

- Support contract — direct line to engineering, response-time SLA
- Telemetry consent — opt-in stream that lets us see your install's health
  before *you* see the outage
- SLA enforcement infrastructure — uptime monitoring + escalation paths
- Audit-grade attestation that your install is licensed for N seats until
  date D for customer C

It says, in effect, "this install is registered with us." It does not unlock
code paths. The software runs identically with or without it.

## Why we promise this

Three reasons, in increasing order of business consequence:

1. **The regulated-client mixed-deployment story depends on it.** A consultant
   who handles NDA client data needs to self-host for that tenant and use
   Cloud for the rest. If the OSS install is crippled, they can't.

2. **Open-source security review is our strongest enterprise pitch.** "Audit
   the RLS code yourself" only works if what you're auditing is the actual
   product, not a stripped-down marketing build.

3. **The open-core narrative dies the moment we put a `if (license)` check
   in a feature path.** Every contributor and customer who sees that diff
   correctly concludes the OSS install is a demo. There is no walking that
   back.

## How we enforce it

A CI check —
[`.github/workflows/oss-parity-check.yml`](../.github/workflows/oss-parity-check.yml)
— runs on every PR and `main` push. It greps the TypeScript source under
`packages/**` and `apps/**` for feature-gating patterns:

```
if (... license ...)
process.env.PRZM_LICENSE ...
plan === 'enterprise' | 'cloud' | 'pro' | 'premium'
tier === 'enterprise' | 'cloud' | 'pro' | 'premium'
isPremium | isEnterprise | hasLicense | isLicensed
```

If any non-allowlisted file matches, the build fails.

The allowlist —
[`.github/workflows/oss-parity-allowlist.txt`](../.github/workflows/oss-parity-allowlist.txt)
— exists for **exactly one** legitimate use: the license verifier itself,
which has to read license state in order to expose it (claim extraction,
expiry checks, signature verification). That file is sacred. Nothing else
goes in.

## The `BREAK-OSS-PARITY` escape hatch

If you genuinely need to add or extend the verifier — adding a new claim,
hardening signature verification, etc. — and the new code legitimately
references license state, do **all three**:

1. Add the file path to `.github/workflows/oss-parity-allowlist.txt`.
2. Open the PR with a clear justification in the description.
3. Get a reviewer to comment `BREAK-OSS-PARITY: <one-line reason>` on the PR.

The third step is the gate. The CI check itself is opportunistic — it can
be bypassed mechanically by allowlisting — so the human review is what
actually prevents abuse. A reviewer comment without a clear justification
should not unblock the merge.

If you find yourself wanting to allowlist a file that isn't part of the
verifier surface, **stop**. You're about to break the parity contract.
Talk to the team before continuing.

## Smoke test

The audit alone can't prove "an OSS user can actually use this." Run
[`scripts/smoke-oss.sh`](../scripts/smoke-oss.sh) for an end-to-end check:
a clean clone, `docker compose up`, ingest a fixture corpus, run a
tenant-scoped search, assert tenant isolation. **No license env vars set.**

CI runs this on every PR that touches the compose / deploy / scripts surface
(see [`.github/workflows/oss-smoke.yml`](../.github/workflows/oss-smoke.yml)).

## See also

- [README.md](../README.md) — "Open-core posture" section
- [docs/DECISIONS.md](DECISIONS.md) — ADR-021 (przm-access integration; the
  RLS substrate that makes multi-tenancy enforceable in OSS)
- [@onenomad/przm-access](https://github.com/OneNomad-LLC/przm-access) —
  the access plane (Apache-2.0 contract; license verifier planned here)
