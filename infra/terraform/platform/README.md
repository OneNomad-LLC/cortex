# Terraform: przm platform (DO Droplet + DNS + cloud-init bootstrap)

A thin module that provisions a DigitalOcean Droplet, points two subdomains at it, and runs the platform Compose substrate (`deploy/platform/`) from cloud-init. End-to-end, `terraform apply` produces a TLS-served multi-tenant cortex + przm-access stack, talking to a managed Postgres (Neon) you supply.

## Prereqs

- A **DO account** with:
  - The apex domain (`var.domain_base`) already registered as a domain in your DO networking panel (we add records to it — we don't create the apex).
  - At least one **SSH key** uploaded (its fingerprint goes in `ssh_key_fingerprints`).
  - An **API token** with `droplet:write` + `domain:write`.
- A **Neon project** (or any managed PG): two databases (or schemas) for the access service and the cortex memory store. Run the role setup SQL in `deploy/platform/README.md` against the cortex DB.
- **Terraform 1.6+** locally.

## Use

```bash
cd infra/terraform/platform
cp terraform.tfvars.example terraform.tfvars
chmod 600 terraform.tfvars   # secrets
$EDITOR terraform.tfvars     # fill in
terraform init
terraform plan
terraform apply
```

Outputs include the droplet's IP, the cortex/access URLs, and an SSH command. Caddy gets TLS certs for both subdomains on first request; the stack is healthy in ~2 minutes (DO image pull + Compose start).

## What it does

- Provisions a DigitalOcean Droplet (Ubuntu 24.04 by default, configurable size/region) tagged `przm-platform`.
- Renders `cloud-init.yaml.tftpl` into the Droplet's user_data, which on first boot:
  1. Installs `docker.io`, `docker-compose-v2`, `jq`, `openssl`, `git`.
  2. Clones the cortex repo at `var.cortex_repo_ref` into `/opt/przm/cortex`.
  3. Runs `deploy/platform/bootstrap.sh` in **non-interactive mode** (env vars from Terraform variables) — this generates the EdDSA keypair + random admin/MCP secrets and writes `.env` (chmod 600), `cortex.yaml`, `Caddyfile`.
  4. Enables a `przm-platform.service` systemd unit that brings the Compose stack up (and back up on reboot).
- Creates A + AAAA records for `cortex.<domain>` and `access.<domain>` pointing at the Droplet.

## Sensitive material — where it lives

| Value | Lives in |
|---|---|
| DO API token | `terraform.tfvars` (chmod 600) on operator's machine. Better: `TF_VAR_do_token` from a secret manager. |
| Postgres URLs | `terraform.tfvars` → DO user_data (metadata) → `/opt/przm/.bootstrap-env` on droplet (chmod 600). |
| EdDSA private key + admin/MCP secrets | **Generated on the droplet** by `bootstrap.sh` (never leave the box). Stored in `/opt/przm/cortex/deploy/platform/.env` (chmod 600). |
| Terraform state | Local `.tfstate` by default — **contains sensitive values**. Configure a remote backend (DO Spaces / S3) with encryption for any team use. |

For SOPS / Vault integration later, see the platform README's secrets section.

## Updates

- **Image-only update** (no Terraform change): SSH in and `docker compose -f docker-compose.platform.yml --env-file .env pull && ... up -d`. The systemd unit will keep the stack up across droplet reboots.
- **Cortex ref / config update**: bump `cortex_repo_ref` or other vars and `terraform apply`. **Note: this currently does NOT re-run cloud-init** (only on droplet replacement). For an in-place update, SSH in and `git pull` + re-run bootstrap. A future improvement: a small `null_resource` with `remote-exec` that pulls + restarts on tfvars change.
- **Rotate secrets**: SSH in, delete `.env`, re-run `bootstrap.sh`, `docker compose ... up -d` (the EdDSA keypair changes — clients must re-auth). The Terraform module is not in the rotation loop.

## What this module is NOT (yet)

- Multi-environment (staging vs prod) — instantiate twice with separate state.
- Floating IP / failover — single droplet, single IP.
- Managed Postgres provisioning — Neon is created out-of-band; this module only consumes its URL.
- SOPS / Vault / Spaces backend — local state for v0. Add a `backend.tf` for any team use.
- Per-tenant dedicated stack — multi-tenant is the default. Per-tenant stamping reuses this module with a per-tenant name + DB.

Reasonable next steps:
- Add a `digitalocean_spaces_bucket` for cortex backups + a daily cron.
- Add Tailscale to the droplet so the access admin API never hits the public internet.
- Move to `digitalocean_app` once cortex's runtime fits its constraints (websockets/long-poll TBD).
