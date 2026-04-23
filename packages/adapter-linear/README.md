# @onenomad/cortex-adapter-linear

Linear source adapter. Uses Linear's GraphQL API.

Config in `config/cortex.yaml`:

```yaml
adapters:
  linear:
    package: "@onenomad/cortex-adapter-linear"
    enabled: true
    schedule: "0 */3 * * *"
    config:
      teams: []                   # team keys, e.g. [ENG, DESIGN]
      pageSize: 50
      maxIssuesPerRun: 0
      teamToProject:              # rule-based classifier
        ENG: engineering
        DESIGN: design
      defaultProject: ""
```

Required secrets (`.env`):

- `LINEAR_API_KEY` — personal API key from <https://linear.app/settings/api>

Feeds into `@onenomad/cortex-pipeline-doc`. Each issue's title, description, and
comments are flattened into a single markdown doc.
