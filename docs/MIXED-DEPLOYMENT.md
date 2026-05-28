# Mixed-Deployment Operator Guide

> One Organization. Multiple tenants. Some on our Cloud. Some on your
> own infrastructure. One invoice.

---

## Mental model

The przm billing layer organizes everything under an **Organization**:

```
Organization ("Lila's Agency")
  ├── Cloud tenant: fintech-saas       (deployment_mode = 'cloud')
  ├── Cloud tenant: ecommerce-brand    (deployment_mode = 'cloud')
  └── Self-hosted tenant: healthcare   (deployment_mode = 'self_hosted',
                                        license_id = 'jti-abc-123')
```

Every tenant — regardless of where it runs — belongs to exactly one
Organization. The Organization is the unit of billing and seat-counting.

**One human = one seat** across all tenants in the org. A user who holds
memberships in three tenants under the same org occupies a single seat.
This is enforced at the query layer (`countActiveSeats` JOINs through
`tenant` without filtering on `deployment_mode`).

**License keys** are EdDSA-signed JWTs (Ed25519). The access service issues
them; each self-hosted Cortex install verifies the token signature independently
using the same Ed25519 public key distributed with the release. The `license_id`
stored on the tenant row is the `jti` claim of that JWT — a stable reference
for audit and revocation without pulling in license-system internals as a FK.

---

## Two deployment modes

| Mode | Where Cortex runs | Who manages infra | Token verification |
|---|---|---|---|
| `cloud` | OneNomad-operated fleet | OneNomad | Access service (online) |
| `self_hosted` | Customer's infra (Hetzner, GCP, on-prem…) | Customer | Each Cortex install (offline-capable) |

Cloud tenants need no special setup beyond creation. Self-hosted tenants
need a license key that proves entitlement even when offline.

---

## Provisioning a self-hosted tenant

### 1. Create the tenant via the admin API

```bash
curl -s -X POST https://access.onenomad.io/admin/orgs/<ORG_ID>/tenants \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "healthcare-client",
    "name": "Healthcare Client",
    "deploymentMode": "self_hosted"
  }'
```

Response includes the tenant `id`. Keep it — you will need it when issuing
the license.

### 2. Issue the license JWT

Use the `issue-license` CLI (currently `feat/air-gap-perpetual-key`):

```bash
przm-access issue-license \
  --tenant-id  <TENANT_ID> \
  --org-id     <ORG_ID> \
  --plan       departmental \
  --seat-count 50 \
  --expires    2027-12-31 \
  --signing-key /secrets/ed25519-license-key.pem
```

The CLI prints the signed JWT and its `jti`. Store the `jti` back on the
tenant record:

```bash
curl -s -X PATCH https://access.onenomad.io/admin/tenants/<TENANT_ID>/license \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"licenseId": "<JTI>"}'
```

Or include `licenseId` in the original POST body:

```bash
curl -s -X POST https://access.onenomad.io/admin/orgs/<ORG_ID>/tenants \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug":           "healthcare-client",
    "name":           "Healthcare Client",
    "deploymentMode": "self_hosted",
    "licenseId":      "<JTI>"
  }'
```

### 3. Send the license JWT to the customer

The customer places the JWT at the path configured in their Cortex install
(default: `$CORTEX_CONFIG_DIR/license.jwt`). Cortex reads it at startup and
on each `/healthz` probe.

Alternatively distribute via environment variable:

```bash
CORTEX_LICENSE_JWT=<signed-jwt>
```

### 4. Customer runs Terraform

The customer applies their own Terraform module against their cloud account.
We do not provision their infrastructure — we issue the key. See the
[platform Terraform module](../deploy/platform/README.md) for the reference
configuration they can adapt.

```bash
cd my-cortex-infra/
terraform apply \
  -var="license_jwt=$(cat /path/to/license.jwt)" \
  -var="tenant_id=<TENANT_ID>" \
  -var="access_service_url=https://access.onenomad.io"
```

### 5. Register Cortex with the access service (optional SSO)

If the customer wants SSO, create the WorkOS SSO connection and attach it:

```bash
curl -s -X POST https://access.onenomad.io/admin/tenants/<TENANT_ID>/sso \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ssoConnectionId": "conn_workos_xyz"}'
```

Cloud and self-hosted tenants share the same SSO connection model.

---

## Seat math

The seat count lives on the Organization, not on individual tenants.

**Counting query** (simplified):

```sql
SELECT count(DISTINCT m.user_id) AS seats_used
FROM membership m
JOIN tenant t ON t.id = m.tenant_id
WHERE t.organization_id = $1
-- deployment_mode is not filtered — a user counts once regardless of mode
```

**Example:**

| User | Cloud membership | Self-hosted membership | Seats consumed |
|---|---|---|---|
| Alice | fintech-saas: editor | healthcare: viewer | **1** |
| Bob | ecommerce-brand: owner | — | 1 |
| Carol | — | healthcare: editor | 1 |
| **Total** | | | **3** |

Alice's two memberships still count as one seat because both tenants share
the same Organization.

**Invoicing** (Task #09 Stripe bridge):

`GET /admin/orgs/:id` returns the org with tenants grouped by mode:

```json
{
  "id": "org_...",
  "slug": "lilas-agency",
  "seatCount": 20,
  "tenants": {
    "cloud": [
      { "id": "...", "slug": "fintech-saas",    "deploymentMode": "cloud"       },
      { "id": "...", "slug": "ecommerce-brand", "deploymentMode": "cloud"       }
    ],
    "self_hosted": [
      { "id": "...", "slug": "healthcare",      "deploymentMode": "self_hosted",
        "licenseId": "jti-abc-123"                                               }
    ]
  }
}
```

The Stripe bridge maps this to invoice line items:

```
Cortex Crew (Cloud) — fintech-saas       5 seats × $25/mo   $125.00
Cortex Crew (Cloud) — ecommerce-brand    3 seats × $25/mo    $75.00
Self-Hosted Departmental — healthcare    license #jti-abc-123  $2,083.33
```

---

## Token verification flow

Access tokens are Ed25519-signed JWTs issued by the access service. They
contain `tenant_id` and `organization_id` claims.

**Cloud tenants**: every API request hits the access service's `/verify`
endpoint. The access service is online; no license needed.

**Self-hosted tenants**: each Cortex install holds the Ed25519 public key
bundled with the release. It verifies tokens locally without phoning home.
The license JWT proves that the install is entitled to do this (offline
verification is a feature gated by the license plan).

On first startup with a license, Cortex caches the public key from the
`CORTEX_ACCESS_PUBLIC_KEY` environment variable. Subsequent token verifications
are pure Ed25519 signature checks — no network hop required.

Token claims relevant to the mixed-deployment flow:

| Claim | Description |
|---|---|
| `sub` | User id (`app_user.id`) |
| `tid` | Tenant id (`tenant.id`) |
| `oid` | Organization id (`organization.id`) |
| `role` | Membership role in `tid` |
| `dep` | Deployment mode (`"cloud"` or `"self_hosted"`) |

The `dep` claim lets downstream services route requests to the right
infrastructure tier without a DB lookup.

---

## Checklist — adding a self-hosted tenant to an existing org

- [ ] `POST /admin/orgs/:id/tenants` with `deploymentMode: "self_hosted"`
- [ ] Record the returned `tenant.id`
- [ ] Issue license JWT with `issue-license` CLI
- [ ] Store the `jti` back as `licenseId` on the tenant (PATCH or include in POST)
- [ ] Deliver the signed JWT to the customer
- [ ] Customer configures `CORTEX_LICENSE_JWT` and runs `terraform apply`
- [ ] Verify `GET /admin/orgs/:id` shows the new tenant in `tenants.self_hosted`
- [ ] Run `GET /admin/orgs/:id/seats` to confirm seat count is as expected

---

## Troubleshooting

**"license JWT signature invalid"** — the public key bundled in the customer's
Cortex release does not match the private key used to sign. Re-issue the license
with the correct key pair.

**"license expired"** — extend the license expiry with `issue-license --expires
<new-date>` and re-deliver. No tenant record changes needed unless the `jti`
changes.

**Seat count higher than expected** — a user may have memberships in tenants
outside this org. `countActiveSeats` only counts tenants under the queried org.
Use `GET /admin/tenants/:id/members` to audit individual tenant memberships.

**Self-hosted tenant missing from `GET /admin/orgs/:id`** — the tenant was
created without an `organization_id`. Run
`POST /admin/orgs/:id/tenants` to create a new one, or
`PATCH /admin/tenants/:id` to set `organizationId`.
