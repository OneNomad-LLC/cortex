# @cortex/adapter-notion

Notion source adapter.

Config in `config/cortex.yaml`:

```yaml
adapters:
  notion:
    package: "@cortex/adapter-notion"
    enabled: true
    schedule: "0 */6 * * *"
    config:
      # Either/both of:
      databases: ["abc123...def"]       # database ids to sync
      pages: ["xyz456..."]               # standalone page ids to include
      pageSize: 50
      maxPagesPerRun: 0                  # 0 = unlimited
      databaseToProject:                 # rule-based classifier
        abc123def: engineering
      defaultProject: ""                 # fallback slug if no rule matches
```

Required secrets (`.env`):

- `NOTION_API_KEY` — integration token from <https://www.notion.so/profile/integrations>

Remember to share the target databases/pages with your integration from
within Notion — API tokens alone don't grant access.

Feeds into `@cortex/pipeline-doc`.
