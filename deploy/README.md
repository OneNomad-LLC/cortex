# Cortex Deployment Assets

Cortex ships in two distinct deployment shapes. Each lives in its own subdirectory so it's obvious which artifacts belong to which path.

## URL conventions (user-facing)

| Service | Prod | Dev |
|---|---|---|
| Login + dashboard | `pyre.sh` | `dev.pyre.sh` |
| Per-tenant Cortex (MCP + API) | `<tenant-slug>.cortex.pyre.sh` | `<tenant-slug>.cortex-dev.pyre.sh` |
| Cortex base image (Fly registry) | `registry.fly.io/przm-cortex-base` (internal) | same |

URLs are documentation only — per the no-hardcoded-environment-URLs policy, no source code references these as constants. Users type the pyre-web URL at login; tenant URLs come back from pyre-web in the device-poll response.

## `fly/` — Hosted Cortex Cloud (per-tenant Fly Machines)

This is the **production** path. pyre-web's tenant provisioner is the only thing that creates per-tenant Fly apps; this directory documents the contract.

**Build target lives at the repo root** (not under `deploy/fly/`) because Fly's build context defaults to the directory containing `fly.toml`, and the Dockerfile needs the whole monorepo as its context:

- `<repo-root>/fly.toml` — Fly app manifest for the **base image** (`przm-cortex-base`). Build-only; nothing actually runs in this app.
- `<repo-root>/Dockerfile` — multi-stage build that assembles the unified server + dashboard image.

### Publish a new base image

```sh
# From the repo root:
fly deploy -a przm-cortex-base --build-only --push
```

That builds the Dockerfile remotely on Fly's builder, tags the result as `registry.fly.io/przm-cortex-base:latest`, and pushes it. pyre-web's provisioner references that tag via `FLY_PRZM_CORTEX_IMAGE`.

### Tagged builds (preview, pinned versions)

```sh
fly deploy -a przm-cortex-base --build-only --push --image-label v0.4
```

Then set `FLY_PRZM_CORTEX_IMAGE=registry.fly.io/przm-cortex-base:v0.4` in pyre-web's env.

### How tenant deploys actually happen

1. User signs up for Pyre Enterprise on `pyre.sh`
2. pyre-web's tenant provisioner (`fly apps create cortex-<slug>`) spins up a new app from the base image
3. pyre-web injects per-tenant secrets (`PRZM_CORTEX_API_AUTH_TOKEN`, `PRZM_CORTEX_MCP_AUTH_TOKEN`, Postgres connection string)
4. pyre-web assigns the custom domain (`fly certs add <slug>.cortex.pyre.sh`)
5. Tenant's Cortex is reachable at `<slug>.cortex.pyre.sh`

The cortex repo never knows about individual tenants; it only publishes the image they all share.

### env-var contract (the API between cortex and pyre-web)

| Variable | Purpose |
|---|---|
| `PRZM_CORTEX_MCP_TRANSPORT` | `http` for hosted; defaults to `stdio` for laptop |
| `PRZM_CORTEX_MCP_HOST` / `PRZM_CORTEX_MCP_PORT` | Where the MCP server binds (3100) |
| `PRZM_CORTEX_MCP_AUTH_TOKEN` | Bearer required to call the MCP HTTP transport |
| `PRZM_CORTEX_API_ENABLED` | Must be `true` for the dashboard API + child to come up |
| `PRZM_CORTEX_API_HOST` / `PRZM_CORTEX_API_PORT` | Dashboard API bind (4141) |
| `PRZM_CORTEX_API_AUTH_TOKEN` | Bearer required to call the dashboard API |
| `PRZM_CORTEX_DASHBOARD_PORT` | Where the dashboard child Next.js listens (3030) |
| `PRZM_CORTEX_DASHBOARD_AUTOSTART` | Whether the server spawns the dashboard child |
| `DATABASE_URL` | Postgres + pgvector connection string (per-tenant) |

Future: extract this contract into a shared `@onenomad/przm-cortex-env-types` package so pyre-web's TypeScript build fails when cortex changes the contract incompatibly. Tracked under task #8.

## `laptop/` — Self-hosted on a single machine

Reverse-proxy + systemd assets for users who want to run Cortex on their own box (a homelab server, an old MacBook, etc.).

- `Caddyfile.template` — Caddy reverse-proxy config in front of the cortex MCP + API
- `cortex.service` — systemd unit for running cortex as a daemon
- `cortex.env.template` — env-var template for the systemd unit

### Quickstart

```sh
# 1. Install cortex globally (or symlink from a checkout)
npm install -g @onenomad/przm-cortex

# 2. Copy + edit the env template
sudo cp deploy/laptop/cortex.env.template /etc/cortex.env
sudo $EDITOR /etc/cortex.env

# 3. Install the systemd unit
sudo cp deploy/laptop/cortex.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cortex

# 4. Front it with Caddy (optional)
sudo cp deploy/laptop/Caddyfile.template /etc/caddy/Caddyfile
# edit hostnames; reload caddy
```

### Why not docker-compose?

`docker-compose.yml` at the repo root works for laptop deploys too — it's the multi-container variant (separate server + dashboard containers). The systemd path here is for users who don't want Docker on their box.

## What lives where — quick reference

| Need to… | Look at |
|---|---|
| Publish a new Fly base image | `fly.toml` + `Dockerfile` at repo root |
| Understand tenant provisioning | This file's `fly/` section + `pyre-web/src/server/cortex-provisioner.ts` |
| Run cortex on a personal server | `deploy/laptop/` + `docker-compose.yml` |
| Run cortex in your shell for development | `pnpm dev` from `packages/server/` |
