# Dedicated stack deploy — runbook

Manual procedure for spinning up a **dedicated cloud** for one enterprise
customer — their own DigitalOcean Droplet, their own Neon project, their own
subdomain — without writing any new automation.

This is the operator's hands-on runbook. It replaces the "click to deploy"
automation that was deliberately deferred (see [`przm-access#16`][1]
and the 3-agent scope review summarized in
[`przm-access/PLAN.md` §13][2] follow-up notes): provisioning automation pays
back only once a meaningful number of dedicated customers exist. Until then,
operator labor is cheaper than a half-built control plane.

[1]: https://github.com/OneNomad-LLC/przm-access/pull/16
[2]: ../../onenomad/przm-access/PLAN.md

---

## When to use this

Use this runbook when:
- An enterprise customer has bought a **dedicated cloud** (one stack, one VM,
  one DB project, just for them).
- You want the same shape as `deploy/platform/` but with the customer-specific
  variables (subdomain, region, DB credentials) isolated from the shared
  platform's Terraform state.

Do **not** use this for:
- Adding a new tenant to the **shared** multi-tenant cloud — that's just
  `POST /admin/tenants` on the existing platform's access service.
- On-prem / air-gap customers — they run their own infra; you ship them the
  container images + a Compose file + (for air-gap) a perpetual license JWT.

---

## What you'll produce

After this runbook:

1. A new Neon **project** named `przm-<customer-slug>` with two databases
   (`access_db`, `cortex_db`) inside it.
2. A new DigitalOcean **Droplet** named `przm-<customer-slug>` running the
   same Compose stack (`cortex` + `przm-access` + `caddy`) as `platform/`,
   parameterized via that customer's `.env`.
3. Two public HTTPS endpoints:
    - `https://access.<customer-slug>.<domain_base>` — access service
    - `https://cortex.<customer-slug>.<domain_base>` — cortex MCP
4. One row in **`deployment`** on the access plane registering this stack
   so the operator console (`/admin/ops/deployments`) sees it.

---

## Prereqs

You need, in addition to what `deploy/platform/README.md` lists:

- A **dedicated Neon project** for this customer. Two-DB-per-project is fine;
  one project per customer is **the** isolation boundary that distinguishes
  dedicated from shared. Do not point a dedicated stack at the shared Neon
  project.
- DNS apex (`<domain_base>`) already managed in the same DigitalOcean account.
  This runbook adds `access.<customer-slug>.<domain_base>` and
  `cortex.<customer-slug>.<domain_base>` records via the Terraform.
- The customer's `organization` row already created in the shared platform's
  access service (`POST /admin/orgs` — slug + name + plan). You'll need that
  org UUID in the last step.

---

## Step 1 — Create the customer's Neon project

In the Neon dashboard:

1. New project → name `przm-<customer-slug>` → region close to the chosen
   DigitalOcean region.
2. Inside the project, create two databases: `access_db` and `cortex_db`.
3. In `cortex_db`, create the restricted app role (SQL block lifted verbatim
   from `deploy/platform/README.md` — see the "Cortex DB roles" section there).
4. Grab two connection strings:
   - `access_database_url` — points at `access_db`, owner role.
   - `cortex_database_url` — points at `cortex_db`, base role that is a
     MEMBER of `cortex_db_app_role`.

Keep both out of source control. Paste them into the `.tfvars` file in
step 3.

---

## Step 2 — Copy the platform module

```bash
cd cortex/infra/terraform
cp -r platform dedicated-<customer-slug>
cd dedicated-<customer-slug>

# Each dedicated stack gets its own Terraform state directory. Local state is
# fine for v1; if you want remote state, configure a per-customer S3/Spaces
# backend here BEFORE the first `init`.
rm -f terraform.tfstate*  # purge any state copied from platform/
```

We're cribbing `platform/` rather than introducing a separate
`infra/terraform/dedicated/` module. The shape is identical; only the
variable values differ. Refactor into a real shared module if and when a
third dedicated stack proves the abstraction pays back.

---

## Step 3 — Write the customer's `terraform.tfvars`

Create `terraform.tfvars` in `dedicated-<customer-slug>/`:

```hcl
do_token             = "dop_v1_…"          # same DO token as platform/
domain_base          = "przm.sh"
droplet_name         = "przm-<customer-slug>"
droplet_region       = "nyc3"              # or fra1 for EU customers
droplet_size         = "s-2vcpu-4gb"       # bump for heavier customers
ssh_key_fingerprints = ["aa:bb:cc:…"]      # same as platform/

# Per-customer Neon creds from step 1
access_database_url  = "postgres://…@…neon.tech/access_db?sslmode=require"
cortex_database_url  = "postgres://…@…neon.tech/cortex_db?sslmode=require"
cortex_db_app_role   = "cortex_app"        # default; matches the SQL in step 1

openrouter_api_key   = ""                  # leave blank to use bundled embedder
cortex_repo_ref      = "main"              # pin to a tag for stable channels
```

**Important:** if `droplet_name` is the same as in `platform/`, DO will refuse.
Always prefix with `przm-` + customer slug.

---

## Step 4 — `terraform apply`

```bash
terraform init
terraform plan -out plan.tfplan
terraform apply plan.tfplan
```

Expect ~5–10 minutes for the Droplet boot + cloud-init Compose pull + Caddy
TLS bootstrap. The DNS records propagate within seconds (DigitalOcean DNS).

Capture the outputs:

```bash
terraform output access_url     # → https://access.<customer-slug>.<domain_base>
terraform output cortex_url     # → https://cortex.<customer-slug>.<domain_base>
terraform output droplet_ipv4
```

---

## Step 5 — Smoke tests

From your laptop:

```bash
ACCESS_URL=$(terraform output -raw access_url)
CORTEX_URL=$(terraform output -raw cortex_url)

curl -s "$ACCESS_URL/health" | jq .
# → {"status":"ok","service":"przm-access"}

curl -sS "$CORTEX_URL/health" | jq .
# → {"status":"ok","service":"cortex"}  (or whatever cortex's /health returns)
```

If either fails, SSH in (`terraform output -raw ssh_command`) and check
`docker compose logs` under `/opt/przm/`. Don't proceed to Step 6 with a
non-200 health endpoint — `/admin/deployments/:id/health` will record the
deployment as `down` and the operator console will look like the stack is
broken.

---

## Step 6 — Register the deployment in the operator console

In the **shared** platform's operator console (the one at
`https://app.przm.sh/admin/ops/deployments`), click **Register deployment**
and fill:

| Field         | Value                                                       |
|---------------|-------------------------------------------------------------|
| Label         | `<customer-slug>-dedicated`                                 |
| Region        | `nyc3` (or whichever DO region you used)                    |
| Endpoint URL  | the `access_url` from Step 4                                |
| Organization  | the org UUID for this customer (the prereq)                 |
| Notes         | `tf dir: dedicated-<customer-slug>; deployed YYYY-MM-DD`    |
| Initial status| `Live` (you just smoke-tested it)                           |

The deployment row is what makes the dedicated stack visible to the rest of
the platform. The per-row **Ping** button on the list will probe
`<endpoint>/health` on demand and update the status.

Alternatively via the admin API directly:

```bash
ADMIN_KEY=…
ORG_ID=…
ACCESS_URL=…  # from Step 4

curl -sS -X POST "$PLATFORM_ACCESS_URL/admin/deployments" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "orgId":       "$ORG_ID",
  "label":       "<customer-slug>-dedicated",
  "region":      "nyc3",
  "endpointUrl": "$ACCESS_URL",
  "status":      "live",
  "notes":       "tf dir: dedicated-<customer-slug>"
}
JSON
```

---

## Step 7 — Provision the customer's first tenant + owner

The dedicated stack's access service is empty. You need to seed it via the
**dedicated stack's** admin API (NOT the shared platform's — they're separate
deployments with separate keys). The dedicated admin key was generated during
cloud-init and lives in `/opt/przm/.env` on the Droplet — SSH and grep
`PRZM_ACCESS_ADMIN_API_KEY=` to retrieve it.

```bash
DED_ADMIN_KEY=…  # from /opt/przm/.env on the new droplet
DED_ACCESS_URL=…  # access_url from Step 4

# 1. Owner user
curl -sS -X POST "$DED_ACCESS_URL/admin/users" \
  -H "Authorization: Bearer $DED_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@customer.com","name":"Customer Owner"}'

# 2. Tenant (slug = the customer's main workspace)
curl -sS -X POST "$DED_ACCESS_URL/admin/tenants" \
  -H "Authorization: Bearer $DED_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slug":"<customer>","name":"<Customer Co>"}'

# 3. Owner membership
curl -sS -X POST "$DED_ACCESS_URL/admin/tenants/$TENANT_ID/members" \
  -H "Authorization: Bearer $DED_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"owner@customer.com\",\"role\":\"owner\"}"
```

(If the customer is doing SSO-only login, you can skip the explicit owner
user/membership creation and let SSO JIT-provision them on first login —
just set `tenant.sso_connection_id` to their WorkOS Connection id when you
create the tenant.)

---

## Rollback

If something goes wrong mid-`terraform apply` or after Step 6:

```bash
cd cortex/infra/terraform/dedicated-<customer-slug>
terraform destroy
```

Then **manually delete** the registered `deployment` row in the operator
console (or `DELETE /admin/deployments/:id` via the API). The Neon project
can be deleted from the Neon dashboard. DO DNS records are removed by the
destroy.

---

## When to upgrade this to automation

The 3-agent review's threshold: **~4 paying dedicated customers**, OR the
6th deploy queued, whichever comes first. At that point, extract a
`przm-provisioner` service that:

- Triggers `terraform apply` via GitHub Actions `workflow_dispatch`
- Owns per-customer TF state (TF Cloud workspaces or S3-backed remote state)
- Posts `/admin/deployments` + `/admin/deployments/:id` updates back to the
  shared platform's access service via the existing audit-webhook pattern

The TF module + the deployment table + the operator UI built today all carry
forward — nothing in this runbook becomes throwaway when automation arrives.
