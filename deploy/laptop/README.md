# Cortex laptop / self-hosted deployment

Reverse-proxy and systemd assets for running Cortex on your own machine — a homelab server, a spare Linux box, or a long-running development workstation.

## What's here

| File | Purpose |
|---|---|
| `cortex.service` | systemd unit definition. Drop into `/etc/systemd/system/`. |
| `cortex.env.template` | Environment variables consumed by the systemd unit. Copy to `/etc/cortex.env` and edit. |
| `Caddyfile.template` | Caddy reverse-proxy config sitting in front of the MCP + API. Optional but recommended for HTTPS. |

## Quickstart

```sh
# 1. Install cortex globally
npm install -g @onenomad/cortex

# 2. Configure env
sudo cp deploy/laptop/cortex.env.template /etc/cortex.env
sudo $EDITOR /etc/cortex.env  # set DATABASE_URL, auth tokens, etc.

# 3. Install + start the systemd unit
sudo cp deploy/laptop/cortex.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cortex
sudo systemctl status cortex

# 4. Front it with HTTPS via Caddy (optional)
sudo cp deploy/laptop/Caddyfile.template /etc/caddy/Caddyfile
sudo $EDITOR /etc/caddy/Caddyfile  # set your hostnames
sudo systemctl reload caddy
```

## Don't want systemd?

`docker-compose.yml` at the repo root is the multi-container variant — separate server and dashboard containers via per-package Dockerfiles. Run from the repo root:

```sh
docker compose up -d
```

That's the simpler path if Docker is already installed and you don't want to manage a systemd unit.

## How is this different from the Fly path?

The `fly/` deployment is OneNomad's **hosted** offering — pyre-web provisions per-tenant Fly Machines from a unified base image, mints per-tenant auth tokens, and handles SSO/billing. It's bundled with Pyre Enterprise.

The `laptop/` path here is for users who want to **self-host** — single-tenant, single-machine, no pyre-web involvement, no per-tenant provisioning. Trade-offs:

- ✓ Your data stays on your hardware
- ✓ No subscription
- ✗ You manage updates, backups, TLS certs, monitoring
- ✗ No SSO, no audit logging, no compliance posture out of the box

For a team of ~5+ that doesn't want to run infrastructure, the hosted offering is usually the right call.
