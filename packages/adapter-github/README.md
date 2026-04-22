# @cortex/adapter-github

GitHub source adapter. Reads a repo's default-branch tree via the git
trees API, fetches each file's raw content, and feeds
`@cortex/pipeline-code`.

Config:

```yaml
adapters:
  github:
    package: "@cortex/adapter-github"
    enabled: true
    schedule: "0 4 * * *"
    config:
      repos: ["owner/alpha-backend", "owner/alpha-frontend"]
      branch: ""                   # empty = default branch per repo
      includeGlobs: ["**/*.ts", "**/*.py", "**/README.md"]
      excludeGlobs: ["**/node_modules/**", "**/dist/**"]
      maxFilesPerRun: 0
      repoToProject:               # rule-based classifier
        "owner/alpha-backend": project-alpha
      defaultProject: ""
```

Required secret:

- `GITHUB_TOKEN` — fine-grained PAT with repository contents read scope
