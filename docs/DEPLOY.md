# Deploy Cortex to a VPS

Step-by-step for putting Cortex on an always-on box so your laptop
can close and the dashboard stays reachable. Uses Docker +
Tailscale — simplest reliable pattern for a single-user deploy.

For hardware choice and budget, see [HOSTING.md](./HOSTING.md). For
"why Docker instead of systemd," see ADR-017 in DECISIONS.md.

## What you'll end up with

```
your laptop (browser, Claude Code)
        │
        │  Tailscale (private)
        ▼
 ┌─ VPS ──────────────────────────────┐
 │  docker compose                    │
 │    ├─ cortex      :3100 MCP HTTP  │
 │    │              :4141 API       │
 │    │   └─ engram + persona        │
 │    │       (stdio subprocesses)   │
 │    └─ dashboard   :3030 Next.js   │
 └────────────────────────────────────┘
```

No ports are exposed to the public internet. All reach is via the
Tailscale tailnet you already belong to.

## Prerequisites

- A VPS with Docker + docker compose installed. Any distro; Ubuntu
  24.04 LTS is what the rest of this guide assumes.
- A Tailscale account (free tier is fine). Tailscale running on the
  VPS *and* on every laptop you'll access Cortex from.
- At least one LLM API key. OpenRouter is easiest — one key covers
  Anthropic, OpenAI, Google, Mistral, and more. Grab one at
  <https://openrouter.ai/keys>.

## 1. Install Tailscale on the VPS

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Authenticate the link from the URL it prints. The VPS now has a
`100.x.x.x` Tailscale IP and a MagicDNS name like
`<hostname>.<tailnet>.ts.net`.

Lock down public SSH afterwards if you want (`sudo ufw deny 22` and
SSH over Tailscale only). Not required for Cortex to work.

## 2. Clone the repo on the VPS

```bash
git clone <your-cortex-fork-url>
cd cortex
cp .env.example .env
```

## 3. Fill in `.env`

Only two fields are critical for a first boot:

```dotenv
OPENROUTER_API_KEY=sk-or-...
PRZM_CORTEX_HOME_HOST=/home/YOU/.cortex   # where workspaces + OAuth tokens persist
```

Leave the port settings at their defaults. The compose file binds
published ports to `127.0.0.1` inside the VPS — Tailscale reaches
them via the VPS's tailnet IP without any firewall tweaks.

## 4. Bring the stack up

```bash
docker compose up -d
```

First run takes a few minutes: pnpm install + TypeScript build +
Next.js standalone bundle. Watch progress with:

```bash
docker compose logs -f
```

When you see `cortex-1  | api.listening` and
`dashboard-1  | Ready`, you're up.

## 5. Reach the dashboard from your laptop

On your laptop (which is also on the tailnet), open:

```
http://<vps-tailscale-name>:3030/setup
```

Use the MagicDNS name Tailscale assigned to the VPS. You'll land on
the setup page where you configure the LLM provider, create a
workspace, and enable adapters — no more terminal involvement.

## 6. Point Claude Code at the remote MCP

On your laptop, edit `~/.config/claude/mcpServers.json` (or the
VS Code Claude extension's settings):

```jsonc
{
  "cortex": {
    "type": "http",
    "url": "http://<vps-tailscale-name>:3100/mcp",
    // No auth — Tailscale is the trust boundary.
  }
}
```

Restart Claude Code. `/tools` should list Cortex's tools alongside
anything else you have wired.

## Common follow-ups

### Use your existing `~/.cortex` workspace from a laptop

Set `PRZM_CORTEX_HOME_HOST` to the bind-mount source path. On a fresh VPS
you'll start with an empty workspace — run through /setup in the
dashboard, or rsync your laptop's `~/.cortex` to the VPS path you
bound.

### Pointing the dashboard at a different port

Set `PRZM_CORTEX_DASHBOARD_PORT` in `.env` before `docker compose up`.

### Updates

```bash
cd /path/to/cortex
git pull
docker compose build
docker compose up -d
```

Images get rebuilt; the bind-mounted workspace + engram state
survive untouched.

### Backups

LanceDB (engram's store) lives under the `PRZM_CORTEX_HOME_HOST` bind
mount. A daily `tar` + upload to Backblaze B2 is enough for single-
user scale. See HOSTING.md for a sketch.

## Without Tailscale

If you can't use Tailscale, you need an auth layer in front of the
dashboard and MCP — the app has zero built-in auth. Two paths:

- **Cloudflare Tunnel + Cloudflare Access**: wrap the exposed ports
  in a tunnel, gate with an Access policy that requires your email.
  No inbound firewall changes. Free.
- **Caddy + bearer token**: Caddy in front of ports 3030 and 3100
  with basic-auth or a custom bearer-token check, Let's Encrypt for
  TLS.

Both are fine, both are more setup than Tailscale. Only go this way
if you have a concrete reason to avoid Tailscale.

## Troubleshooting

### `OPENROUTER_API_KEY` errors on startup

The env-expansion pass lists unset vars by name. Re-check `.env`.

### Dashboard loads but "Couldn't reach the Cortex API"

Inside the compose network the dashboard reaches cortex at
`http://cortex:4141`. Check `docker compose logs cortex` for
startup errors — the API won't answer until engram/persona
subprocesses finish booting.

### Claude Code can't see Cortex tools

Curl the MCP endpoint from the laptop: `curl
http://<vps>:3100/health`. If that fails, Tailscale isn't reaching
the VPS; if it succeeds, the Claude Code config is wrong.
