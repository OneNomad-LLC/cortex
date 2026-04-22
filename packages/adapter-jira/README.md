# @cortex/adapter-jira

Atlassian Jira Cloud source adapter.

Config in `config/cortex.yaml`:

```yaml
adapters:
  jira:
    package: "@cortex/adapter-jira"
    enabled: true
    schedule: "0 */3 * * *"
    config:
      workspace: "yourcompany"           # <subdomain>.atlassian.net
      projects: ["ENG", "ROAD"]          # Jira project keys
      jql: "resolution = Unresolved"     # optional extra filter
      pageSize: 50
      maxIssuesPerRun: 0                 # 0 = unlimited
      projectToCortex:                   # rule-based classifier
        ENG: engineering
        ROAD: product
```

Required secrets (`.env`):

- `ATLASSIAN_EMAIL`
- `ATLASSIAN_API_TOKEN`

Reuses the same token that Confluence uses — create once at
<https://id.atlassian.com/manage-profile/security/api-tokens>.

Feeds into `@cortex/pipeline-doc`. Each issue's summary, description,
and comments are concatenated into a single markdown doc.
