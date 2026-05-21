# Hosting

Where Cortex, Engram, and Persona should run.

## Requirements

- Always-on (MCP endpoints must be reachable from any of the author's machines)
- Persistent local storage (LanceDB is file-based and benefits from fast SSD)
- ~4-8 GB RAM (Node runtimes + LanceDB + embedding model on CPU)
- 40-160 GB SSD (grows with memory store; plan for growth)
- US region preferred (lower latency from author's location; most company
  tooling is also US-hosted)
- Backup-friendly (LanceDB data is irreplaceable)
- Low cost (personal project, not a business)
- Private by default (not publicly exposed on the internet)

## Recommendation: Hetzner CPX21 (US) + Tailscale

**Hardware**: Hetzner Cloud CPX21 — 3 vCPU AMD EPYC, 4 GB RAM, 80 GB NVMe SSD,
US region (Ashburn VA or Hillsboro OR).

**Cost**: ~$9-10/month after April 2026 price adjustment.

**Networking**: Tailscale for access from personal machines. Never expose MCP
endpoints publicly.

**Backup**: Daily snapshots to Backblaze B2 (~$0.006/GB/month, pennies for this
scale) via a cron job. Plus Hetzner's built-in backup option (~20% of server
cost = $2/month) for point-in-time recovery.

**Total**: ~$12-15/month.

### Why this wins

Hetzner has the best price-to-performance ratio for small VPS workloads. The
CPX21 is comfortably specced for three Node services plus LanceDB. NVMe SSD
matters for LanceDB performance.

Tailscale keeps the MCP endpoints private to a user's own devices without
needing to mess with firewall rules or public DNS. Free for personal use.

Pick a US region if your other tooling and SaaS lives in the US — it
matters for latency.

## Alternatives Considered

### DigitalOcean / Vultr / Linode

Comparable specs run $15-24/month. Hetzner wins on value. Use DO/Vultr if
you already have an account and credits, otherwise no reason.

### Fly.io

Good for container-oriented apps with persistent volumes. Fine fit, but
LanceDB's file-based access pattern runs best on a traditional VPS with
local NVMe. Container-platform overhead adds complexity without clear benefit
here.

### Railway / Render

Developer-friendly deploys, but pricing gets expensive for always-on services
with real resource usage. $20+/month minimum for meaningful resources. Worse
value than Hetzner.

### Home server (Mac mini, Raspberry Pi, etc.)

Zero marginal cost after hardware, full control, no vendor lock-in. Requires
handling your own network (Tailscale handles most of it), power backup (UPS),
and ISP stability. Good option if you already have a home server; overkill to
buy one just for this.

A Mac mini M4 Pro with 48GB RAM can run everything including local LLM
inference. ~$1,800 upfront but pays back in ~12 years at $12/month cloud cost,
so really only worth it if you want local LLM always-available or have other
uses for the hardware.

### M5 Pro laptop as the host

Works, but the laptop closes, moves, goes offline. The whole point of hosting
is always-on. Don't use a laptop.

### AWS / GCP / Azure

Overkill for personal use. Pricing math doesn't work out. Skip.

## Security

### Tailscale

- Install Tailscale on VPS and all client machines
- Enable SSH via Tailscale (disable public SSH or restrict to Tailscale IPs)
- MCP endpoints bind to Tailscale interface only, never 0.0.0.0

### Firewall

Hetzner Cloud Firewalls (free):
- Allow inbound 22 (SSH) from your Tailscale IP only
- Allow inbound ICMP for debugging
- Allow all outbound (for API calls to Google, Atlassian, Loom, OpenRouter)
- Deny everything else inbound

### Secrets

- `.env` file on the server, readable only by the service user, never
  committed to the repo.
- Rotate API tokens if you ever accidentally expose them.
- Use read-only API scopes where possible (especially Atlassian, Bitbucket).

### Updates

- Automatic security updates via `unattended-upgrades` on Ubuntu/Debian.
- Monthly manual check for Node, Ollama, Engram, Persona, Cortex updates.

## Backup Strategy

### What to back up

- LanceDB data directories from Engram and Persona (`~/.claude/engram/`,
  `~/.claude/persona/` or wherever they're configured)
- Cortex config (projects.yaml, people.yaml) — already in git but belt and
  braces
- `.env` files (encrypted, e.g., via age or sops)

### How

Daily cron job:
1. Stop services briefly (or snapshot via copy-on-write if filesystem supports)
2. `tar` + `zstd` the data directories
3. Upload to Backblaze B2 with date-stamped filename
4. Prune backups older than 30 days

Weekly: restore drill. Actually run the restore procedure into a scratch
directory to confirm backups are valid.

### Restore procedure

Document in a RUNBOOK.md when you get to it. At minimum:

```bash
# On fresh VPS
# 1. Install Node, Ollama, clone repos
# 2. Download latest backup from B2
# 3. Extract to ~/.claude/ paths
# 4. Set permissions
# 5. Start services
# 6. Verify MCP endpoints respond
# 7. Test a query end-to-end
```

## Initial Provisioning

Rough sequence once you've signed up for Hetzner and Tailscale:

1. Create CPX21 server in preferred US region, Ubuntu 24.04 LTS
2. Add your SSH key during creation
3. SSH in, update packages
4. Install Tailscale: `curl -fsSL https://tailscale.com/install.sh | sh`
5. Authenticate Tailscale: `tailscale up`
6. Create firewall in Hetzner console, attach to server
7. Install Node 20, Ollama (if running models on the VPS) or skip Ollama
   if M5 handles extraction
8. Clone Engram, Persona, Cortex repos
9. Configure systemd services or use PM2 for process management
10. Set up Backblaze B2 bucket and backup cron
11. Connect Claude Code / Claude.ai to the new MCP endpoints

Claude Code can generate the systemd units, the backup script, and a
provisioning script once the VPS exists. Don't hand-write these.

## When to Upgrade

Start with CPX21 ($9/month). Upgrade to CPX31 ($18/month, 4 vCPU / 8 GB / 160 GB)
when any of:

- LanceDB responses start feeling slow (memory pressure)
- You're running local LLM inference on the VPS (more RAM needed)
- Storage approaches 50 GB used
- Multiple concurrent ingestions cause noticeable slowdowns

For reference, Engram's data footprint grows roughly 1-5 MB per thousand
memories, so 80 GB is a long runway.
