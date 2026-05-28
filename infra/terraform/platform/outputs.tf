output "droplet_ipv4" {
  description = "Public IPv4 of the platform droplet. Use to SSH for log inspection."
  value       = digitalocean_droplet.platform.ipv4_address
}

output "droplet_ipv6" {
  description = "Public IPv6 of the platform droplet."
  value       = digitalocean_droplet.platform.ipv6_address
}

output "cortex_url" {
  description = "Public MCP endpoint (TLS via Caddy/Let's Encrypt)."
  value       = "https://${local.cortex_subdomain}.${var.domain_base}"
}

output "access_url" {
  description = "Public access service endpoint (admin API + SSO callback host)."
  value       = "https://${local.access_subdomain}.${var.domain_base}"
}

output "ssh_command" {
  description = "SSH into the droplet. The bootstrap secrets are at /opt/przm/cortex/deploy/platform/.env (chmod 600)."
  value       = "ssh root@${digitalocean_droplet.platform.ipv4_address}"
}
