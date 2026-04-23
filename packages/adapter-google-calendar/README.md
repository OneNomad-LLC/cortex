# @onenomad/cortex-adapter-google-calendar

Google Calendar source adapter. Ingests events as Cortex memories so
pre-meeting briefs have structure to work from.

Config in `config/cortex.yaml`:

```yaml
adapters:
  google-calendar:
    package: "@onenomad/cortex-adapter-google-calendar"
    enabled: true
    schedule: "*/30 * * * *"
    config:
      calendars: ["primary"]       # calendar ids, "primary" = user's main
      lookAheadDays: 14
      lookBackDays: 1
      pageSize: 250
      calendarToProject:           # rule-based classifier
        primary: ""                # blank = unclassified
      defaultProject: ""
```

Required OAuth scopes: `https://www.googleapis.com/auth/calendar.readonly`.
See `@onenomad/cortex-google-auth` for token setup.

Feeds into `@onenomad/cortex-pipeline-doc` for now — each event becomes a doc
memory. A dedicated `pipeline-event` is on the roadmap if richer event
handling becomes needed.
