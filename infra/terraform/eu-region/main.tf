locals {
  cortex_subdomain = "cortex-eu"
  access_subdomain = "access"
  # The cortex deployment must advertise itself as the EU region so the
  # token-based region enforcement middleware rejects US-tenant tokens.
  cortex_region_label = "eu"
}

# -----------------------------------------------------------------------------
# Droplet — EU-resident compute. Default region: fra1 (Frankfurt).
#
# NOTE: Do not apply this module until operator has:
#   1. Enabled billing on DigitalOcean for the Frankfurt region.
#   2. Provisioned a Neon project in eu-central-1 and set cortex_database_url.
#   3. Completed the DPA with DigitalOcean (frankfurt.digitalocean.com DPA).
#   4. Had legal review the dpa-template.md and signed it with each EU tenant.
# See docs/runbooks/eu-region-smoke-test.md for the pre-flight checklist.
# -----------------------------------------------------------------------------
resource "digitalocean_droplet" "platform_eu" {
  name       = var.droplet_name
  region     = var.droplet_region
  size       = var.droplet_size
  image      = var.droplet_image
  ssh_keys   = var.ssh_key_fingerprints
  ipv6       = true
  monitoring = true
  backups    = true # EU tenants require backup; toggle off only in dev

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    domain_base         = var.domain_base
    access_database_url = var.access_database_url
    cortex_database_url = var.cortex_database_url
    cortex_db_app_role  = var.cortex_db_app_role
    openrouter_api_key  = var.openrouter_api_key
    cortex_repo_url     = var.cortex_repo_url
    cortex_repo_ref     = var.cortex_repo_ref
    access_public_jwk   = var.access_public_jwk
    access_issuer       = var.access_issuer
    cortex_region       = local.cortex_region_label
  })

  tags = ["przm-platform", "eu-region"]
}

# -----------------------------------------------------------------------------
# DNS — cortex-eu.<domain_base> A/AAAA records.
# The US deployment owns cortex.<domain_base> and access.<domain_base>;
# this module only adds the EU cortex subdomain.
# -----------------------------------------------------------------------------
resource "digitalocean_record" "cortex_eu_v4" {
  domain = var.domain_base
  type   = "A"
  name   = local.cortex_subdomain
  value  = digitalocean_droplet.platform_eu.ipv4_address
  ttl    = 300
}

resource "digitalocean_record" "cortex_eu_v6" {
  domain = var.domain_base
  type   = "AAAA"
  name   = local.cortex_subdomain
  value  = digitalocean_droplet.platform_eu.ipv6_address
  ttl    = 300
}
