# Air-gap Deployment Guide

This guide covers deploying Cortex in a network-isolated (air-gap) environment where no outbound internet access is permitted. This is the configuration sold as the Air-gap Add-on.

## Prerequisites

Before you begin, confirm the following:

- **No outbound internet.** The host running Cortex cannot reach external networks. Your firewall or network policy enforces this.
- **Docker or compatible container runtime** available on the isolated host, or Node 20+ for a bare-metal install.
- **A signed perpetual license JWT** issued by OneNomad for the contract term (see "License install" below).
- **A local or on-premises LLM endpoint** reachable from the Cortex host (e.g., Ollama on the same host, or an internally hosted OpenAI-compatible endpoint). Cortex does not ship a bundled model.
- **Local source adapters only.** Adapters that require outbound access (GitHub, Confluence, Loom, etc.) must point at internally hosted instances or be disabled.

## Obtaining the perpetual license

Contact your OneNomad account representative. Provide:

1. The customer name exactly as it should appear in the license.
2. The maximum tenant count you need.
3. The contract end date (the license will be issued to expire on that date).

OneNomad will run:

```sh
PRZM_ACCESS_LICENSE_PRIVATE_JWK='...' \
npx tsx scripts/issue-license.ts \
  --customer "Your Org" \
  --tenants 50 \
  --expires-after 1095 \
  --mode perpetual \
  --out your-org-license.jwt
```

You will receive a file containing a single signed JWT (three base64url segments joined by dots). This file is the license. Treat it like a private key — anyone with it can activate Cortex for your org.

## License install

Set the license JWT in the environment before starting Cortex:

```sh
export PRZM_CORTEX_LICENSE_JWT="$(cat your-org-license.jwt)"
```

For Docker or systemd, add it to your environment file:

```
PRZM_CORTEX_LICENSE_JWT=eyJhbG...
```

Cortex reads and verifies the JWT at boot using the bundled public key. No network call is made — verification is a local EdDSA signature check. If the JWT is absent, expired, or has an invalid signature, Cortex refuses to start with a clear error message.

### What "perpetual" means in the license

A perpetual license JWT carries a `mode: "perpetual"` claim alongside its `exp` (expiry) timestamp. The verifier treats it identically to an annual license — it checks the signature and expiry, nothing more. The mode claim is informational: it tells the operator "this key is designed to last for the contract term without any annual file exchange." You will never be prompted to refresh it online.

When the contract ends, a new license must be issued. There is no automatic renewal.

## Telemetry kill-switch

Set this environment variable to disable all outbound platform calls:

```sh
export PRZM_CORTEX_TELEMETRY=disabled
```

This is required for air-gap deployments. When set:

- `cortex worker` refuses to start (the worker polls pyre-web for jobs, which requires outbound network access; in air-gap mode, trigger ingestion directly via MCP tools instead).
- `cortex tenant refresh` refuses to run (pyre-web is unreachable; manage tenants via the credentials file directly).
- No other platform calls are affected — these are the only two that phone home to OneNomad infrastructure.

**What is NOT blocked by `PRZM_CORTEX_TELEMETRY=disabled`:**

| Call | Category | Air-gap behavior |
|---|---|---|
| LLM provider (Ollama, internal OpenAI-compatible) | User-configured | Allowed — operator configures the endpoint |
| Source adapters (GitHub, Confluence, Loom, etc.) | User-configured | Allowed — operator configures the endpoint; point at internal instances |
| Memory backend (pgvector) | User-configured | Allowed — operator configures the database URL |
| `cortex worker` polling pyre-web | Platform | Blocked by `PRZM_CORTEX_TELEMETRY=disabled` |
| `cortex tenant refresh` | Platform | Blocked by `PRZM_CORTEX_TELEMETRY=disabled` |

Default behavior (without the env var) is unchanged. The kill-switch is opt-in.

## Cortex outbound profile in air-gap mode

With `PRZM_CORTEX_TELEMETRY=disabled`, the full outbound profile at steady state is:

1. **LLM endpoint** — one or more configured `PRZM_CORTEX_LLM_*` endpoints, all on your internal network.
2. **Source adapter endpoints** — whatever APIs you configure (internal GitHub Enterprise, internal Confluence, etc.).
3. **pgvector / Postgres** — your internal database host.
4. **Nothing else.** The MCP server itself makes no spontaneous outbound calls during normal operation.

During initial setup (one-time, can be done on a networked machine before transfer):

- Pulling the Docker image.
- Pulling Ollama models (if using Ollama).

After the image and models are loaded onto the air-gapped host, no further outbound access is needed for the lifetime of the deployment.

## Verifying zero egress

### Option 1: tcpdump

On the Cortex host, capture all non-local traffic while running a full ingest cycle:

```sh
# Capture on the external interface (replace eth0 with your interface name)
sudo tcpdump -i eth0 -n 'not (src net 127.0.0.0/8 or dst net 127.0.0.0/8)' \
  -w /tmp/cortex-egress.pcap &

# Run Cortex and trigger an ingest
PRZM_CORTEX_TELEMETRY=disabled cortex serve &
# ... trigger ingest via MCP tool or CLI ...

# Stop capture and inspect
sudo kill %1
sudo tcpdump -r /tmp/cortex-egress.pcap | grep -v 'your-internal-hosts'
```

Expected result: no packets to external IP ranges (0.0.0.0/0 minus your internal subnets). Any packet to an unexpected destination is a finding.

### Option 2: Kubernetes NetworkPolicy

If deploying on Kubernetes, apply an egress NetworkPolicy that allows only your internal services:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cortex-air-gap-egress
  namespace: cortex
spec:
  podSelector:
    matchLabels:
      app: cortex
  policyTypes:
    - Egress
  egress:
    # Allow DNS
    - ports:
        - protocol: UDP
          port: 53
    # Allow your internal LLM endpoint (Ollama default; adjust for your setup)
    - to:
        - ipBlock:
            cidr: 10.0.0.0/8
      ports:
        - protocol: TCP
          port: 11434
    # Allow your internal Postgres / pgvector
    - to:
        - ipBlock:
            cidr: 10.0.0.0/8
      ports:
        - protocol: TCP
          port: 5432
    # Allow your internal source adapters (GitHub Enterprise, Confluence, etc.)
    # Add additional rules here for each internal service
```

With this policy in place, any unintended egress is dropped by the kernel before it leaves the pod. Verify with `kubectl describe networkpolicy cortex-air-gap-egress`.

### Option 3: iptables / firewalld

Drop all outbound traffic to non-internal destinations at the OS level:

```sh
# Allow established connections and loopback
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Allow your internal subnets (adjust ranges)
iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT

# Drop everything else
iptables -A OUTPUT -j DROP
```

Then start Cortex and attempt a full ingest. No iptables DROP events should appear in `dmesg` or `journalctl -k` for unexpected destinations.

## Security team sign-off checklist

The following items must be verified before production use in an air-gapped environment. This checklist is designed for a network security reviewer.

- [ ] **License verified offline.** Confirmed that `PRZM_CORTEX_LICENSE_JWT` is set and Cortex boots successfully without any outbound network access (tested by blocking all egress at the firewall before starting the process).
- [ ] **`PRZM_CORTEX_TELEMETRY=disabled` set in the deployment environment.** Confirmed in the running process environment (`/proc/<pid>/environ` or `docker inspect`).
- [ ] **Worker process not running.** Confirmed `cortex worker` is not running (it is not needed in air-gap mode and will refuse to start due to the telemetry guard).
- [ ] **LLM endpoint is internal.** The `PRZM_CORTEX_LLM_*` environment variables point to an internally hosted endpoint. Verified by reviewing the deployment configuration.
- [ ] **Source adapters point to internal instances.** Any enabled adapters (GitHub, Confluence, Jira, etc.) are configured to reach internally hosted services. Verified by reviewing `cortex.yaml`.
- [ ] **Egress baseline captured.** A tcpdump or network policy test was performed during a full ingest cycle. No traffic to external (non-internal-subnet) destinations was observed.
- [ ] **License expiry noted.** The license expiry date is recorded in the team's key-management system. A calendar reminder is set 60 days before expiry to request a replacement license from OneNomad.
- [ ] **Docker image provenance confirmed.** The container image digest is pinned in the deployment manifest and matches the digest published in the OneNomad release notes for the installed version.

## Environment variable reference

| Variable | Required | Description |
|---|---|---|
| `PRZM_CORTEX_LICENSE_JWT` | Yes | Signed license JWT issued by OneNomad. |
| `PRZM_CORTEX_TELEMETRY` | Yes (air-gap) | Set to `disabled` to block pyre-web platform calls. |
| `PRZM_CORTEX_LLM_*` | Yes | Configure your internal LLM endpoint. See `docs/SETUP.md`. |
| `PRZM_CORTEX_HOME_HOST` | Yes (Docker) | Host path to mount as Cortex's data directory. |
| `DATABASE_URL` | If using pgvector | Postgres connection string for the vector store. |

## Support

For license issues, contact support@onenomad.app. Air-gap customers have a dedicated support SLA; include your customer name and the `customer` claim from your license JWT in the subject line.

For security findings, report to security@onenomad.app with the subject "Air-gap Security Finding".
