variable "do_token" {
  type        = string
  description = "DigitalOcean API token with droplet:write + domain:write."
  sensitive   = true
}

variable "domain_base" {
  type        = string
  description = "Apex domain managed in this DO account. cortex-eu.<base> A/AAAA records will be created."
}

variable "droplet_name" {
  type        = string
  description = "Hostname / DO Droplet name."
  default     = "przm-platform-eu"
}

variable "droplet_region" {
  type        = string
  description = "DO region slug. fra1 = Frankfurt (EU-Central) — required for EU data residency."
  default     = "fra1"

  validation {
    condition     = contains(["fra1", "ams3", "lon1"], var.droplet_region)
    error_message = "EU region must be one of: fra1 (Frankfurt), ams3 (Amsterdam), lon1 (London)."
  }
}

variable "droplet_size" {
  type        = string
  description = "DO Droplet size slug."
  default     = "s-2vcpu-4gb"
}

variable "droplet_image" {
  type        = string
  description = "Base OS image. Ubuntu 24.04 has docker.io in apt."
  default     = "ubuntu-24-04-x64"
}

variable "ssh_key_fingerprints" {
  type        = list(string)
  description = "DO SSH key fingerprints authorized on the droplet."
}

variable "access_database_url" {
  type        = string
  description = "Postgres connection string for przm-access (shared US instance — access service is single-region)."
  sensitive   = true
}

variable "cortex_database_url" {
  type        = string
  description = "Postgres connection string for the EU cortex memory backend. MUST point to a Neon project in eu-central-1 (Frankfurt) to satisfy data-residency requirements."
  sensitive   = true
}

variable "cortex_db_app_role" {
  type        = string
  description = "Restricted NOSUPERUSER Postgres role the cortex RLS-scoped path lowers into."
  default     = "cortex_app"
}

variable "openrouter_api_key" {
  type        = string
  description = "Optional OpenRouter key for LLM-routed embeddings. Blank = local Xenova embedder."
  default     = ""
  sensitive   = true
}

variable "cortex_repo_url" {
  type        = string
  description = "Cortex repo to clone."
  default     = "https://github.com/OneNomad-LLC/cortex.git"
}

variable "cortex_repo_ref" {
  type        = string
  description = "Cortex repo ref to deploy. Pin to a tag for stable channels."
  default     = "main"
}

variable "access_public_jwk" {
  type        = string
  description = "JSON-serialised przm-access EdDSA public JWK. Used by cortex to verify bearer tokens and enforce EU-tenant routing."
  sensitive   = true
}

variable "access_issuer" {
  type        = string
  description = "Expected `iss` claim in przm-access tokens."
  default     = "https://access.przm.sh"
}
