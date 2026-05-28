variable "do_token" {
  type        = string
  description = "DigitalOcean API token with droplet:write + domain:write."
  sensitive   = true
}

variable "domain_base" {
  type        = string
  description = "Apex domain managed in this DO account. Subdomains cortex.<base> and access.<base> will be created."
}

variable "droplet_name" {
  type        = string
  description = "Hostname / DO Droplet name."
  default     = "przm-platform"
}

variable "droplet_region" {
  type        = string
  description = "DO region slug (nyc1, nyc3, sfo3, ams3, fra1, lon1, ...)."
  default     = "nyc3"
}

variable "droplet_size" {
  type        = string
  description = "DO Droplet size slug. s-2vcpu-4gb is a sane starting point for the platform; bump as load grows."
  default     = "s-2vcpu-4gb"
}

variable "droplet_image" {
  type        = string
  description = "Base OS image. Ubuntu 24.04 has docker.io + docker-compose-plugin in apt."
  default     = "ubuntu-24-04-x64"
}

variable "ssh_key_fingerprints" {
  type        = list(string)
  description = "DO SSH key fingerprints authorized on the droplet (from `doctl compute ssh-key list` or the DO UI)."
}

variable "access_database_url" {
  type        = string
  description = "Postgres connection string for the przm-access service (Neon recommended). Held in DO Droplet metadata user_data — rotate any time."
  sensitive   = true
}

variable "cortex_database_url" {
  type        = string
  description = "Postgres connection string for the cortex memory backend. The base role must be a MEMBER of cortex_db_app_role so withRlsScope can SET ROLE."
  sensitive   = true
}

variable "cortex_db_app_role" {
  type        = string
  description = "Restricted NOSUPERUSER Postgres role the cortex RLS-scoped path lowers into. Must already exist in cortex_database_url (see deploy/platform/README.md for the SQL)."
  default     = "cortex_app"
}

variable "openrouter_api_key" {
  type        = string
  description = "Optional OpenRouter key for LLM-routed embeddings. Blank to use cortex's bundled local Xenova embedder."
  default     = ""
  sensitive   = true
}

variable "cortex_repo_url" {
  type        = string
  description = "Cortex repo to clone for the deploy substrate. Override to a fork if needed."
  default     = "https://github.com/OneNomad-LLC/cortex.git"
}

variable "cortex_repo_ref" {
  type        = string
  description = "Cortex repo ref (branch/tag/sha) to clone. Pin to a tag for stable channels."
  default     = "main"
}
