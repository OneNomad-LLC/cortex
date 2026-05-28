# przm platform deploy — multi-tenant cortex + przm-access

This directory stands up the **multi-tenant przm platform** — `cortex` (knowledge plane, MCP server) + `przm-access` (identity/tenancy service, EdDSA token issuer) + Caddy (TLS) — as a single Docker Compose stack on any Linux VM, talking to a managed Postgres (Neon recommended).

It is **not** for the local single-user / personal-Droplet shape (which uses embedded PGlite and doesn't need access). For that, use `deploy/laptop/` or the standalone `cortex` install.

## Architecture (one-screen)

```
        ┌──────────────── Caddy (auto-TLS, :443) ────────────────┐
        │                                                          │
   cortex.<domain>  →  cortex:3100  ──── verifies token ───┐       │
                                  (PRZM_CORTEX_ACCESS_PUBLIC_JWK)  │
                                                                   │
   access.<domain>  →  access-service:4400                         │
        │                          │                               │
        └──────────────────────────┼───────────────────────────────┘
                                   │
                              ┌────┴────┐
                              │  Neon   │
                              │ Postgres│   (separate DBs/schemas)
                              └─────────┘
                              access_db   cortex_db (RLS, two roles)
```

- **Tokens** flow: a client authenticates against `access.<domain>` (admin-API for v0; SSO later) → receives an EdDSA scoped token → presents it to `cortex.<domain>` as `Authorization: Bearer <token>`. cortex verifies, derives a `Principal`, and runs the request inside a Postgres transaction with `app.tenant` set — RLS isolates the tenant's rows.
- **Storage** stays on managed Postgres (Neon); the platform VM is stateless beyond Caddy's TLS cache and cortex's local sessions/cache. **Roll-outs are repeatable** because no state lives on the box.
- **Multi-tenant by default.** One cortex instance + one access service serves N tenants. Tenants are created via the access admin API; isolation is enforced by Postgres RLS, not by spinning up new infra per customer. Dedicated stack per tenant is a future variation (same compose, different `.env`).

## Prereqs

- A Linux VM (any cloud — DO Droplet recommended at this size) with **docker**, **jq**, and **openssl** installed.
- Two **Neon Postgres** projects/databases (or two schemas in one) — see *Role setup* below.
- A domain you control, with two subdomains pointing at the VM's public IP:
  - `cortex.<your-domain>` → MCP server
  - `access.<your-domain>` → access service
- (Optional) An OpenRouter API key if you want LLM-routed embeddings instead of cortex's bundled local model.

## Role setup (Postgres / Neon)

Run this once against each Neon database, as the database owner.

**cortex_db** (the memory DB — RLS enforced):
```sql
-- The restricted role cortex's RLS-scoped path lowers into.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cortex_app') THEN
    CREATE ROLE cortex_app NOSUPERUSER NOLOGIN;
  END IF;
END$$;

GRANT USAGE ON SCHEMA public TO cortex_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public TO cortex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cortex_app;

-- The connection-string base role must be a MEMBER of cortex_app so it can
-- SET ROLE into it inside the withRlsScope transaction.
GRANT cortex_app TO CURRENT_USER;
```

**access_db**: no special role setup required for v0 (the access service runs as the owner). If you want a restricted role for the access RLS-scoped path too, mirror the above and set `ACCESS_DB_APP_ROLE` in `.env`.

cortex's `bootstrap()` will run the rest of the DDL (memory table, indexes, RLS policies) on first start.

## Bootstrap

```bash
git clone https://github.com/OneNomad-LLC/cortex
cd cortex/deploy/platform
./bootstrap.sh
```

The script asks for your domain + the two Neon URLs + the restricted role name, then generates the EdDSA keypair (in a one-shot `node:20-alpine` container so you don't need Node on the host), the admin API key, and the cortex MCP bearer. It writes `.env`, `cortex.yaml`, and `Caddyfile` from the templates and `chmod 600`s the env file. **Keep `.env` off backups** — it carries the private signing key.

Then bring the stack up:
```bash
docker compose -f docker-compose.platform.yml --env-file .env pull
docker compose -f docker-compose.platform.yml --env-file .env up -d
docker compose -f docker-compose.platform.yml ps        # services healthy?
curl https://access.<your-domain>/health                # → {"status":"ok",...}
```

Caddy will obtain TLS certs for both subdomains on first request — make sure DNS is resolving to the box's IP before this.

## First tenant

The access service's admin API is gated by `ACCESS_ADMIN_API_KEY` (in `.env`). Create the first tenant + user + role:

```bash
ADMIN_KEY=$(grep '^ACCESS_ADMIN_API_KEY=' .env | cut -d= -f2)
H="Authorization: Bearer $ADMIN_KEY"
BASE="https://access.<your-domain>"

# 1. Tenant.
curl -sS -X POST -H "$H" -H 'content-type: application/json' \
  "$BASE/admin/tenants" \
  -d '{"slug":"acme","name":"Acme Co"}'
# → {"id":"<tenant-uuid>","slug":"acme",...}

# 2. User.
curl -sS -X POST -H "$H" -H 'content-type: application/json' \
  "$BASE/admin/users" \
  -d '{"email":"founder@acme.co","name":"Founder"}'
# → {"id":"<user-uuid>",...}

# 3. Membership (tenant + role).
curl -sS -X POST -H "$H" -H 'content-type: application/json' \
  "$BASE/admin/tenants/<tenant-uuid>/members" \
  -d '{"userId":"<user-uuid>","role":"owner"}'
```

To mint a scoped token for that user, the platform app calls the access service's token-issue path (or you stub one for testing). Point your MCP client at `https://cortex.<your-domain>` with that token as `Authorization: Bearer <token>` — every memory ingest/search runs in their tenant.

## Updates

```bash
docker compose -f docker-compose.platform.yml --env-file .env pull
docker compose -f docker-compose.platform.yml --env-file .env up -d
```

This pulls `:latest` for both images. To pin a stable channel, set `ACCESS_IMAGE_TAG=v0.1.1` and `CORTEX_IMAGE_TAG=v0.7.1` (or similar) in `.env` and `pull`/`up` again. Workspace volumes (`cortex-data`) and DB state survive image swaps. Schema changes apply via cortex's idempotent bootstrap DO blocks on start.

## What's NOT in this v0

- **Terraform module** to provision the VM + DNS — coming next (this dir is the substrate it'll wrap).
- **WorkOS / AuthKit SSO** — env stubs are present; wire them when you outgrow the admin-API path.
- **Per-tenant adapter scheduling** (Loom, Confluence, GitHub) — adapters are tenant-scoped operationally; multi-tenant scheduling is a future ADR.
- **Audit-log aggregation** — the access service writes audits per-tenant; cross-tenant analytics needs a sink.

## Sizing rough-cut

A small Droplet (DO 4 GB RAM / 2 vCPU, ~$24/mo) plus a Neon Scale tier (~$69/mo) comfortably serves dozens of SMB tenants with steady traffic. Cortex's bundled local-Xenova embedder runs on CPU; add an LLM-router embed provider (OpenRouter) for higher-quality recall. Caddy auto-TLS is free.
