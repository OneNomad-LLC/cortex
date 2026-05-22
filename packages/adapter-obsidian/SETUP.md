# Obsidian adapter

The Obsidian adapter watches a local vault directory and ingests every
markdown file it finds. Memories carry `source: "obsidian"`; their
`project` is inferred from the top-level folder under the vault root.

No token required — Cortex reads the vault directly from disk.

## Wizard fields

- **Vault path** — absolute path to your Obsidian vault root. Example:
  `/Users/matt/Documents/work-vault`. Cortex must be running as a user
  with read access to that directory.
- **Ignore globs** — optional list of glob patterns (relative to the
  vault root) that should be skipped. Sensible defaults:
  - `.obsidian/**` (Obsidian's own config)
  - `_archive/**`
  - `**/.trash/**`

## How project tagging works

The adapter looks for a `project: <slug>` line in the file's YAML front
matter first. Failing that, it uses the top-level folder under the vault
root. If both are missing, the memory is tagged `project: "inbox"` and
shows up under "Unfiled" in the dashboard.

## Watch vs. poll

By default the adapter uses Node's `fs.watch` to react to edits within
seconds. On network mounts where watch events don't propagate, set the
`OBSIDIAN_POLL_MS` env var to a non-zero millisecond value to switch to
polling.

## References

- [Obsidian vault structure][vault]
- [YAML front matter in Obsidian][frontmatter]

[vault]: https://help.obsidian.md/Files+and+folders/Vault
[frontmatter]: https://help.obsidian.md/Editing+and+formatting/Properties
