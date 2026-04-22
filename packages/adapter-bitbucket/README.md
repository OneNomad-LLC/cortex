# @cortex/adapter-bitbucket

Bitbucket Cloud source adapter. Reads repository trees via the REST
`/src` endpoint, ingests source files as code memories through
`@cortex/pipeline-code`.

Config:

```yaml
adapters:
  bitbucket:
    package: "@cortex/adapter-bitbucket"
    enabled: true
    schedule: "0 3 * * *"
    config:
      workspace: "yourcompany"     # Atlassian workspace
      repos: ["alpha-backend", "alpha-frontend"]
      branch: "main"               # branch/commit to read
      includeGlobs: ["**/*.ts", "**/*.py", "**/README.md"]
      excludeGlobs: ["**/node_modules/**", "**/dist/**"]
      maxFilesPerRun: 0
      repoToProject:               # rule-based classifier
        alpha-backend: project-alpha
        alpha-frontend: project-alpha
      defaultProject: ""
```

Required secrets: `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` (shared
with Confluence / Jira).
