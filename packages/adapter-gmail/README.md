# @onenomad/cortex-adapter-gmail

Gmail source adapter. Ingests threads matching a Gmail search query
(`query` / `q` grammar — `label:inbox`, `from:boss@co.com`,
`newer_than:30d`, etc.) as doc memories.

Config:

```yaml
adapters:
  gmail:
    package: "@onenomad/cortex-adapter-gmail"
    enabled: true
    schedule: "0 */2 * * *"
    config:
      query: "label:work newer_than:30d"   # Gmail search syntax
      maxThreadsPerRun: 50
      labelToProject:                      # rule-based classifier
        Label_123: engineering
      defaultProject: ""
```

Required OAuth scopes:

- `https://www.googleapis.com/auth/gmail.readonly`

Feeds `@onenomad/cortex-pipeline-doc` for now. A dedicated `pipeline-email`
(with reply-chain handling, attachment awareness) is on the roadmap.
