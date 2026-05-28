locals {
  cortex_subdomain = "cortex"
  access_subdomain = "access"
}

# -----------------------------------------------------------------------------
# Droplet — runs the platform Compose stack.
# -----------------------------------------------------------------------------
resource "digitalocean_droplet" "platform" {
  name       = var.droplet_name
  region     = var.droplet_region
  size       = var.droplet_size
  image      = var.droplet_image
  ssh_keys   = var.ssh_key_fingerprints
  ipv6       = true
  monitoring = true
  backups    = false # toggle to true once the platform has tenants

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    domain_base         = var.domain_base
    access_database_url = var.access_database_url
    cortex_database_url = var.cortex_database_url
    cortex_db_app_role  = var.cortex_db_app_role
    openrouter_api_key  = var.openrouter_api_key
    cortex_repo_url     = var.cortex_repo_url
    cortex_repo_ref     = var.cortex_repo_ref
  })

  tags = ["przm-platform"]
}

# -----------------------------------------------------------------------------
# DNS — assumes the apex domain is already managed in this DO account.
# (digitalocean_domain "domain_base" must exist; we don't create it here so the
# module is safe to re-apply against a domain already serving other records.)
# -----------------------------------------------------------------------------
resource "digitalocean_record" "cortex_v4" {
  domain = var.domain_base
  type   = "A"
  name   = local.cortex_subdomain
  value  = digitalocean_droplet.platform.ipv4_address
  ttl    = 300
}

resource "digitalocean_record" "access_v4" {
  domain = var.domain_base
  type   = "A"
  name   = local.access_subdomain
  value  = digitalocean_droplet.platform.ipv4_address
  ttl    = 300
}

resource "digitalocean_record" "cortex_v6" {
  domain = var.domain_base
  type   = "AAAA"
  name   = local.cortex_subdomain
  value  = digitalocean_droplet.platform.ipv6_address
  ttl    = 300
}

resource "digitalocean_record" "access_v6" {
  domain = var.domain_base
  type   = "AAAA"
  name   = local.access_subdomain
  value  = digitalocean_droplet.platform.ipv6_address
  ttl    = 300
}
