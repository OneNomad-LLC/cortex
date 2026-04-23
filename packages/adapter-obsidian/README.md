# @onenomad/cortex-adapter-obsidian

Obsidian vault source adapter. Reads markdown files from a local directory,
parses YAML frontmatter for metadata overrides, and tags by path prefix.

Config in `config/cortex.yaml`:

```yaml
adapters:
  obsidian:
    package: "@onenomad/cortex-adapter-obsidian"
    enabled: true
    config:
      vaultPath: "${OBSIDIAN_VAULT_PATH}"   # absolute path to vault root
      # Optional path-prefix → project classifier. First match wins.
      pathToProject:
        - prefix: "work/alpha/"
          project: project-alpha
        - prefix: "work/beta/"
          project: project-beta
      # Files/dirs to skip. Defaults cover .obsidian, .trash, .git.
      ignore: []
      defaultProject: ""                   # fallback slug if no rule matches
```

Required secrets: none.

Required env: `OBSIDIAN_VAULT_PATH` — absolute path to the vault root.

Feeds into `@onenomad/cortex-pipeline-doc`. No file watcher yet — this adapter
does a full-vault scan on each `cortex sync`. A watcher mode using
`fs.watch` is on the roadmap.
