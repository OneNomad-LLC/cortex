output "droplet_ipv4" {
  description = "Public IPv4 of the EU platform droplet."
  value       = digitalocean_droplet.platform_eu.ipv4_address
}

output "droplet_ipv6" {
  description = "Public IPv6 of the EU platform droplet."
  value       = digitalocean_droplet.platform_eu.ipv6_address
}

output "cortex_eu_url" {
  description = "Public EU MCP endpoint (TLS via Caddy/Let's Encrypt)."
  value       = "https://${local.cortex_subdomain}.${var.domain_base}"
}

output "ssh_command" {
  description = "SSH into the EU droplet."
  value       = "ssh root@${digitalocean_droplet.platform_eu.ipv4_address}"
}
