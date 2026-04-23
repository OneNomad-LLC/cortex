# @onenomad/cortex-adapter-google-drive

Google Drive + Docs source adapter. Lists files in configured folders
and exports each Google Doc as markdown for ingestion through
`@onenomad/cortex-pipeline-doc`.

Config:

```yaml
adapters:
  google-drive:
    package: "@onenomad/cortex-adapter-google-drive"
    enabled: true
    schedule: "0 */6 * * *"
    config:
      folderIds: ["abc123"]               # Drive folder ids, recursive
      mimeTypes: ["application/vnd.google-apps.document"]  # Docs only by default
      pageSize: 100
      maxFilesPerRun: 0
      folderToProject:                    # rule-based classifier
        abc123: engineering
      defaultProject: ""
```

Required OAuth scopes:

- `https://www.googleapis.com/auth/drive.readonly`
