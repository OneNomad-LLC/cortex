# @onenomad/cortex-adapter-loom

Loom recordings + transcripts source adapter.

> **Note on Loom API access.** Loom's workspace/REST API requires a
> Business or Enterprise plan, and the exact endpoint shapes are
> evolving. This adapter is structured so its HTTP client is the only
> surface that depends on Loom's specifics — swap it when Loom's API
> changes without touching the adapter/transform layer.

Config in `config/cortex.yaml`:

```yaml
adapters:
  loom:
    package: "@onenomad/cortex-adapter-loom"
    enabled: true
    schedule: "*/15 * * * *"
    config:
      workspace: "yourcompany"             # Loom workspace slug
      folders: []                          # folder ids to scope, empty = all
      pageSize: 50
      maxRecordingsPerRun: 0               # 0 = unlimited
      folderToProject:                     # rule-based classifier
        fld_abc: engineering
      defaultProject: ""
      skipWithoutTranscript: true          # ignore recordings w/o transcript
```

Required secrets (`.env`):

- `LOOM_API_KEY` — workspace API key from Loom admin

Feeds into `@onenomad/cortex-pipeline-meeting` (the 3-pass extraction). Each
recording's transcript becomes a meeting-shaped `ClassifiedItem` whose
run through the pipeline produces a brief plus per-decision and
per-action-item memories.
