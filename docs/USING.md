# Using Cortex day-to-day

Cortex is a daily driver, not a tool you open occasionally. This page
walks through what a typical day with Cortex looks like and where to
go when something specific comes up.

> Setting up for the first time? See [SETUP.md](./SETUP.md). Curious
> how the four MCP servers (cortex / engram / persona / synapse) fit
> together? See [MCP-STACK.md](./MCP-STACK.md).

## A day with Cortex

### Morning — open the dashboard

`localhost:3030` lands on the **Today** timeline:

- **Overdue** — past-due action items, sticky at the top in red
- **Now** — meetings + items in the next 2 hours, bold
- **Today** — the rest of the day at a glance

Each meeting that has a brief cached shows a "brief ready" badge. Each
action item shows its project, owner, and due date.

### Pre-meeting — let the brief land

Cortex's scheduler fires 30 minutes before each calendar event with a
**pre-meeting brief**: attendees, the last few times you met with this
group, open commitments with them, suggested questions. Delivered to
your Slack self-DM if `notifications.yaml` is configured, otherwise
visible on the dashboard via the `upcoming-briefs` widget at
`/widgets`.

### During the day — capture as you go

**Notes.** Click "Notes" in the sidebar (or hit `localhost:3030/notes`).
Write markdown in the TipTap editor. Save lands a `.md` file in
`<obsidian-vault>/cortex-notes/<slug>.md` — visible in your Obsidian
app on disk, and ingested into Engram for search by the obsidian
adapter the moment you save.

Frontmatter fields go above the editor: title, project, tags. They
become YAML at the top of the file:

```markdown
---
slug: thinking-about-the-rfp-response
title: Thinking about the RFP response
project: driven-brands
tags: [strategy, q2]
created: 2026-04-27T17:00:00Z
updated: 2026-04-27T17:30:00Z
source: cortex-notes
---

Body here.
```

**Search.** `localhost:3030/search` runs `search_related` against
Engram. Filters: type (decision / meeting / action_item / doc / …),
source (slack / confluence / obsidian / …), project slug, since-date.
Workspace filter is automatic.

**Action items.** Surfaced on the Today timeline + the
`my-action-items` widget. Currently view-only via the dashboard;
status changes (mark done / snooze) happen via the MCP tools from
inside Claude — the dedicated UI is on the roadmap.

**Asking Claude.** Cortex's MCP tools are available in any Claude
Code, Claude Desktop, or Claude.ai session connected to the Cortex
MCP. Call out:

- `catch_me_up({ project })` → recent activity for a project
- `catch_me_up_on_meeting({ eventId })` → context for a specific event
- `get_project_context({ slug })` → people + recent work
- `search_related({ query, ... })` → semantic retrieval
- `my_action_items()` → open commitments across projects
- `todays_digest()` → narrative roll-up of today's signals
- `note_create({ title, body, project?, tags? })` → write a note from
  Claude (lands as the same kind of file the dashboard editor writes)

### End of day — wrap up

The scheduler's EOD trigger (default 17:00) sends a Slack DM with the
day's open commitments. The `endOfDayPrompt` also surfaces on the
Today timeline as an amber callout after 16:00 local: "X open
commitments still on the timeline — knock them out, push, or move
them."

If you're closing out a Claude Code session, leave a handoff so
tomorrow's morning brief can pick up where you stopped:

```
leave_session_handoff({
  summary: "Stuck on the migration race condition.",
  nextSteps: ["Add jitter to retry backoff"],
  fileRefs: ["packages/server/src/sync.ts:142"],
  platform: "claude-code"
})
```

Tomorrow morning, the dashboard surfaces open handoffs on the Today
timeline; reading them with `read_session_handoffs()` from any Claude
gets you back into context fast.

## Common workflows

### Switching workspaces

Cortex is multi-tenant — one install can serve work + personal +
side-projects with isolated config and memory. Switch via:

- **Dashboard:** click the workspace pill in the header
- **CLI:** `cortex workspace switch <slug>`
- **From Claude:** `switch_workspace({ slug: "personal" })`

After switching, restart Cortex (`cortex down && cortex up` for
docker, or `Ctrl+C` and `cortex start` for native) so the daemon
reloads with the new workspace's config + Engram subprocess.

### Adding a new project

Edit `~/.cortex/workspaces/<slug>/projects.yaml` (or the **Settings →
Projects** tab in the dashboard for raw YAML editing — form-based
editor coming). Slugs are kebab-case; Cortex uses them everywhere.

```yaml
projects:
  - slug: driven-brands
    name: Driven Brands
    active: true
    tags: [client, automotive]
    people: [howard, dima, brittany]
```

Or auto-discover from already-configured adapters:

```bash
cortex add projects
```

(Atlassian + Google Calendar adapters offer to import discovered
spaces / shared calendars as projects.)

### Adding a new adapter

`localhost:3030/adapters` lists every shipped adapter. Click any one
to open its wizard form. The form writes to
`~/.cortex/workspaces/<slug>/config/cortex.local.yaml` and prompts
you for any missing secrets.

CLI equivalent:

```bash
cortex add confluence
cortex add slack
# etc.
```

After the wizard completes, restart Cortex to pick up the new
adapter's cron schedule and webhook handler (if any).

### Rebuilding the dashboard image

The Docker dashboard image is built from source at compose-time. When
you pull new code, you need to rebuild the image:

```bash
docker compose build dashboard
cortex down && cortex up
```

A simple `cortex down/up` only restarts the existing image — your
new code won't be in there.

### Searching across everything

Open `localhost:3030/search`, type a query like "auth migration
decisions". Results return ranked by Engram's hybrid score, filtered
to the current workspace. Click any result's external-link icon to
jump back to the original source.

For programmatic search (or to exclude/include specific types), call
`search_related` from any Claude session:

```
search_related({
  query: "auth migration decisions",
  type: "decision",
  since: "2026-01-01T00:00:00Z",
  limit: 20
})
```

## Tips

- **Active workspace persistence:** the dashboard's workspace switcher
  flips `state.json` immediately, but a running daemon still holds the
  previous workspace's Engram subprocess + config in memory. Always
  restart after switching.
- **Notes appear in Obsidian on disk:** anything you write at `/notes`
  is just a markdown file. The Obsidian app (or any other tool) sees
  the same file. Edit there, save, and Cortex's chokidar watcher
  re-ingests within a second.
- **Workspace bleed defense:** every memory carries a `workspace`
  metadata stamp. Search and widgets filter on it. If you ever see
  cross-workspace data leak in, run `cortex backfill workspace
  --slug <correct-workspace> --dry-run` to audit, then fix-up via
  `memory_update_metadata` (engram-side, once the upstream release
  lands).
- **MCP console for ad-hoc tool calls:** `localhost:3030/mcp` exposes
  the full MCP tool surface as a form-driven invoke UI. Useful for
  testing changes or exercising a tool you don't remember the schema
  for.
- **`cortex doctor --connect`:** pre-flight check before a long
  session. Verifies config, secrets, tokens, taxonomy, and live-probes
  Engram + Postgres if you're using the pgvector fallback.
