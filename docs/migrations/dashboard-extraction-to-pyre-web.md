# Migration: Extract Cortex Dashboard to pyre-web

**Status:** spec — pyre-web side not yet implemented
**Decision recorded:** 2026-05-14 (cortex restructuring discussion)
**Cortex repo task:** #2 (Extract packages/dashboard out of cortex repo)

## Summary

`cortex/packages/dashboard/` (Next.js 15 + Radix UI) moves into pyre-web as a route group. Per-tenant Cortex deployments stop running their own dashboard process; instead, pyre-web's tenant-scoped routes proxy API calls to the tenant's Cortex over HTTP using the per-tenant auth token pyre-web already mints at provisioning time.

## Why

1. **Unified product surface.** One account at `pyre.sh` manages engram cloud usage, persona config, and cortex tenants. Three separate dashboards fragments the brand.
2. **Auth is already there.** pyre-web has sessions, billing, OAuth, account UI. Cortex pages inherit all of it instead of building cross-origin handoff.
3. **Pricing/billing alignment.** Cortex Enterprise is bundled with Pyre Enterprise — one Stripe customer, one invoice. The dashboard should match.
4. **Per-tenant Next.js processes are wasteful.** 100 customers means 100 Fly Machines each running their own Next.js server. Killing the per-tenant dashboard process saves ~150MB of RAM per tenant and removes a class of "dashboard not loading" incidents.
5. **Dockerfile simplification.** The current Dockerfile has ~30 lines of "make Next.js standalone work in a monorepo" gymnastics that all go away.

## Scope on the cortex side (after pyre-web side ships)

- Delete `packages/dashboard/` entirely
- Delete `packages/server/src/dashboard-child.ts` and the `resolveDashboardDir` walk
- Delete the `cortex dashboard` CLI command (`cli/dashboard.ts` and the help-text entry)
- Drop `PRZM_CORTEX_DASHBOARD_AUTOSTART` and `PRZM_CORTEX_DASHBOARD_PORT` env vars
- Simplify Dockerfile (drop `cp -r .next/static` dance, drop `EXPOSE 3030`, drop `pnpm -r build` in favor of server-only build)
- Update README + CHANGELOG
- This is **task #3 + #4** in the parent task list — gated on pyre-web side being verified live

## Scope on the pyre-web side (this spec)

### 1. Route structure

Mount the dashboard under a clean subdir that could be extracted to a standalone repo later if pyre-web outgrows itself:

```
pyre-web/src/app/cortex/
  layout.tsx                        ← cortex shell (sidebar, breadcrumbs)
  [tenantSlug]/                     ← all dashboard pages live under here
    layout.tsx                      ← tenant scope provider (pulls cortex tenant + bearer)
    page.tsx                        ← overview / "today" digest
    knowledge/page.tsx
    notes/page.tsx
    modules/page.tsx
    docs/page.tsx
    workspaces/page.tsx
    logs/page.tsx                   ← (matches the existing logs-panel work)
  page.tsx                          ← tenant picker (when user is not yet on a tenant)
```

User-facing URLs: `pyre.sh/cortex/<tenant-slug>/...` (prod) or `dev.pyre.sh/cortex/<tenant-slug>/...` (dev).

### 2. Auth + bearer plumbing

pyre-web already mints `bearer` tokens per-tenant when provisioning the tenant Fly app. Today those bearers go into `~/.pyre/credentials.json` for the CLI. For the dashboard to call the tenant Cortex's HTTP API, pyre-web's server-side route handlers need to:

- Resolve the requesting user's pyre-web session
- Look up which tenants that user has access to
- Fetch the tenant's `mcp_url` (well, `api_url` — the dashboard hits `/api/*`, not `/mcp`) and `bearer` from pyre-web's Postgres
- Forward dashboard requests to `https://<tenant-slug>.cortex.pyre.sh/api/...` with the `Authorization: Bearer <token>` header attached server-side (never expose the bearer to the browser)

Implementation pattern: a thin server-side proxy under `pyre-web/src/app/api/cortex/[tenantSlug]/[...path]/route.ts` that:
1. Authenticates the pyre-web session
2. Authorizes the user against the tenant
3. Pipes the request through to the tenant Cortex
4. Streams the response back

The dashboard widgets just call relative URLs (`/api/cortex/<tenant-slug>/widgets/recent-activity`) — no cross-origin fetch, no client-side bearer juggling.

### 3. Component imports

Copy these directories from `cortex/packages/dashboard/src/` into `pyre-web/src/app/cortex/`:

```
src/components/   → app/cortex/_components/  (or src/components/cortex/)
src/widgets/      → app/cortex/_widgets/
src/lib/          → src/lib/cortex/
src/app/          → app/cortex/[tenantSlug]/   (page-by-page port)
public/           → public/cortex/             (cortex-specific images, icons)
```

Adjust:
- All API base-URL references swap from `process.env.PRZM_CORTEX_API_URL` to relative `/api/cortex/<tenantSlug>/...`
- Remove anything that assumes single-tenant context — every page now reads `params.tenantSlug` and forwards it

### 4. Dependencies

Add to pyre-web's `package.json` (most of these are likely already present — check `pnpm why` first to avoid duplicates):

```
@radix-ui/react-accordion @radix-ui/react-alert-dialog
@radix-ui/react-avatar @radix-ui/react-checkbox @radix-ui/react-collapsible
@radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-label
@radix-ui/react-popover @radix-ui/react-scroll-area @radix-ui/react-select
@radix-ui/react-separator @radix-ui/react-slot @radix-ui/react-switch
@radix-ui/react-tabs @radix-ui/react-tooltip
```

Plus whatever non-Radix deps the dashboard pulls (recharts, date-fns, etc. — see `cortex/packages/dashboard/package.json`).

### 5. Testing surface

- Each dashboard page renders against a mocked tenant context
- Server-side proxy forwards bearer + body correctly, strips client-set Authorization headers
- Tenant-not-authorized returns 403, not 500
- Tenant unknown returns 404 with a helpful "either no access or tenant doesn't exist" message
- Streaming endpoints (logs, recent-activity) survive the proxy

## Open questions for the pyre-web session

1. **Subdomain vs path:** spec assumes `pyre.sh/cortex/<tenant>` (path-based). Is there appetite for `<tenant>.pyre.sh/cortex` (subdomain-based)? Path is simpler; subdomain isolates session cookies per tenant if that ever matters.
2. **Tenant picker UX:** when a user has access to >1 tenant, where does the picker live? Top of the cortex layout? An account-settings dropdown? A standalone `/cortex` landing page?
3. **Logs streaming:** the existing `packages/dashboard/src/app/logs/logs-panel.tsx` uses Server-Sent Events to a streaming endpoint. Verify pyre-web's proxy handles SSE without buffering — Next.js route handlers do but it's worth a manual check.
4. **Server Actions vs API routes:** the existing dashboard uses route handlers. Worth re-evaluating whether the new code should use Server Actions for mutations to match pyre-web conventions.
5. **Cache strategy:** `packages/dashboard/src/app/lib/api.ts` does its own fetch wrapping. pyre-web has `unstable_cache` and tag-based revalidation patterns. Re-write or port the wrapper as-is?

## Done criteria

- [ ] All dashboard pages render in pyre-web against a real tenant Cortex
- [ ] Server-side proxy authenticates + authorizes correctly
- [ ] Bearer never reaches the browser (verify with devtools network tab)
- [ ] Logs page streams in real time
- [ ] Cortex repo's per-tenant Fly Machines stop running Next.js (verified by `fly logs` showing no `next start` output and reduced memory baseline)
- [ ] Cortex repo's `packages/dashboard/` deleted, Dockerfile simplified, CHANGELOG updated

## Sequencing

This spec exists so a parallel pyre-web Claude session can pick up the work. The cortex side waits for that work to ship and verify before deleting `packages/dashboard/` (task #3 + #4).
