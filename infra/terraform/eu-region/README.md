# EU Cloud Region — Terraform Module

Provisions the EU-resident cortex deployment on DigitalOcean Frankfurt (`fra1`).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Customer MCP client                  │
│          (Claude Code configured with cortex-eu URL)        │
└──────────────────────┬──────────────────────────────────────┘
                       │ Bearer: przm-access JWT (region=eu)
                       ▼
         https://cortex-eu.przm.sh   (this module)
         ┌──────────────────────────────────────┐
         │  cortex (EU)  fra1 Frankfurt Droplet │
         │  PRZM_CORTEX_REGION=eu               │
         │  DB → Neon eu-central-1 (Frankfurt)  │
         │  Region gate: rejects region=us JWTs │
         └──────────────────────────────────────┘

         https://cortex.przm.sh      (platform module, unchanged)
         ┌──────────────────────────────────────┐
         │  cortex (US)  nyc3 Droplet           │
         │  PRZM_CORTEX_REGION=us               │
         │  DB → Neon us-east-1                 │
         └──────────────────────────────────────┘

         https://access.przm.sh      (single-region, shared)
         ┌──────────────────────────────────────┐
         │  przm-access  nyc3 (identity + JWT)  │
         │  Issues tokens with region=us/eu     │
         └──────────────────────────────────────┘
```

**Key design decision:** the access service is single-region (US). It issues
JWTs that carry a `region` claim (`"us"` or `"eu"`) derived from `tenant.region`.
Each cortex deployment reads `PRZM_CORTEX_REGION` and rejects requests where the
token's `region` claim doesn't match. A EU tenant's token is rejected by the US
cortex and accepted only by the EU cortex — no cross-region data leakage.

## Prerequisites

Before `terraform apply`:

1. **Hetzner / DO billing**: enable DigitalOcean Frankfurt (`fra1`) for your account
2. **Neon EU project**: provision a Neon project in `eu-central-1`. Do NOT reuse the US project.
3. **DPA**: complete the DigitalOcean DPA (https://cloud.digitalocean.com/account/legal) and sign `legal/dpa-template.md` with each EU tenant
4. **SSH keys**: have your DO SSH key fingerprints ready (`doctl compute ssh-key list`)
5. **Access JWK**: copy `PRZM_CORTEX_ACCESS_PUBLIC_JWK` from the przm-access service deployment

## Usage

```bash
cd infra/terraform/eu-region
cp terraform.tfvars.example terraform.tfvars
chmod 0600 terraform.tfvars
# Fill in terraform.tfvars — especially cortex_database_url (must be Neon eu-central-1)

terraform init
terraform plan   # review before applying
terraform apply
```

## Smoke Test

See `docs/runbooks/eu-region-smoke-test.md` for the full pre-production checklist.

Quick checks after `terraform apply`:

```bash
# Health check
curl -s https://cortex-eu.przm.sh/api/health | jq .

# Verify region gate rejects a US-tenant token
# (get a US tenant JWT from access service, try it against EU cortex)
curl -H "Authorization: Bearer <us-tenant-jwt>" https://cortex-eu.przm.sh/mcp
# Expected: 403 REGION_MISMATCH

# Verify EU tenant token is accepted
curl -H "Authorization: Bearer <eu-tenant-jwt>" https://cortex-eu.przm.sh/mcp
# Expected: MCP handshake (200 or upgrade)
```

## State

Terraform state is local by default. Before using in production, configure
a remote backend (DO Spaces with state locking, or Terraform Cloud):

```hcl
# backend.tf (create alongside terraform.tfvars, gitignore it)
terraform {
  backend "s3" {
    endpoint = "https://fra1.digitaloceanspaces.com"
    bucket   = "przm-tf-state"
    key      = "eu-region/terraform.tfstate"
    region   = "us-east-1" # DO Spaces uses this string regardless of actual region
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    force_path_style            = true
  }
}
```
