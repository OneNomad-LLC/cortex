# @onenomad/cortex-adapter-confluence

Confluence (Atlassian Cloud) source adapter.

Config in `config/cortex.yaml`:

```yaml
adapters:
  confluence:
    package: "@onenomad/cortex-adapter-confluence"
    enabled: true
    schedule: "0 */6 * * *"   # every 6 hours
    config:
      workspace: "yourcompany"        # yourcompany.atlassian.net
      spaces: ["ENG", "PRODUCT"]      # space keys to sync
      pageSize: 50
      spaceToProject:                 # rule-based classifier
        ENG: engineering
        PRODUCT: product
```

Required secrets (`.env`):

- `ATLASSIAN_EMAIL` — your Atlassian account email
- `ATLASSIAN_API_TOKEN` — create at <https://id.atlassian.com/manage-profile/security/api-tokens>

Feeds into `@onenomad/cortex-pipeline-doc`. See `docs/ARCHITECTURE.md`.
