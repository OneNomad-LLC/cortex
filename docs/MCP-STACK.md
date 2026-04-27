# The MCP stack

Cortex is one of four MCP servers that work together. Each one stays
useful on its own, and you only need the ones that fit your workflow.

```
┌───────────────────────────────────────────────────────────┐
│ Claude Code · Claude Desktop · Claude.ai (web)             │
└───────────────────────────────────────────────────────────┘
                          │ stdio / streamable HTTP
        ┌─────────────────┼─────────────────┬────────────────┐
        ▼                 ▼                 ▼                ▼
   ┌─────────┐       ┌─────────┐       ┌─────────┐     ┌─────────┐
   │ Cortex  │       │ Engram  │       │ Persona │     │ Synapse │
   │ work    │  ───▶ │ memory  │       │ style   │     │ bridge  │
   │ orches- │       │ + KG    │       │ + voice │     │ between │
   │ tration │       │         │       │         │     │ clients │
   └─────────┘       └─────────┘       └─────────┘     └─────────┘
```

Cortex calls Engram and Persona internally over MCP. Synapse is a
peer-to-peer bus between Claude clients (Claude Code session ↔ Claude
Desktop, etc.) and is independent of the other three.

---

## Cortex — work orchestration (this app)

The orchestration layer for a real job. Cortex handles:

- **Source ingestion.** Adapters for Confluence, Jira, Linear, Loom,
  Notion, Obsidian, Google Calendar / Drive / Gmail, Bitbucket,
  GitHub, Slack. Each runs on a schedule or via webhook / file watch.
- **Pipelines.** Doc, meeting (3-pass extraction), code, conversation,
  research. Every ingested item gets a structured metadata stamp so
  search filters work.
- **Workspaces.** Multiple isolated contexts (work + personal +
  side-project) each with their own config and `.env`.
- **Daily-driver tools.** `todays_digest`, `upcoming_briefs`,
  `priorities`, `my_action_items`, `catch_me_up`, `search_related`,
  `note_create / update / delete / list`, identity + job-profile
  config, session handoffs.
- **Local dashboard** (Next.js 15 + shadcn). Today timeline, notes
  editor, semantic search, widget grid, settings, MCP console.

Run it via `cortex start` (stdio MCP) or `cortex up` (Docker compose
with Cortex + dashboard + optional pgvector / Ollama).

→ Full setup: [SETUP.md](./SETUP.md)
→ Architecture details: [ARCHITECTURE.md](./ARCHITECTURE.md)

## Engram — memory + knowledge graph

The persistent memory layer. Cortex calls into Engram on every
ingest and every search, but Engram is designed to be useful on its
own — a generic memory MCP for Claude.

What Engram brings:

- **Hybrid search** — semantic vectors (LanceDB) fused with keyword
  via Reciprocal Rank Fusion. 9-stage retrieval pipeline.
- **Knowledge graph** — entities, edges, timeline queries, KG
  invalidation. Memories link via `source_id` and people / project
  metadata.
- **Cognitive layers** — episodic (raw), semantic (extracted facts),
  procedural (rules / preferences), reference (long-tail).
- **Diary + handoff API** — `memory_diary_write` for end-of-session
  notes, `memory_handoff_*` for cross-session continuity.
- **Memory governance** — trust, sensitivity, status, trace_id
  metadata stamped on every ingest. PII-friendly defaults.

Released as `@onenomad/engram-memory` on npm. Cortex composes it; you
can also point Claude at it directly for a memory-only setup.

When to call Engram MCP tools directly (skipping Cortex):

- Quick `memory_search` from inside Claude when Cortex isn't running
- `memory_diary_write` at the end of a Claude Code session
- `memory_kg_query` for relationship questions
- One-off `memory_ingest` of a paste or screenshot

## Persona — style + voice

The personality layer. Persona learns how *you* talk and how Claude
should sound when helping with your work — tone, sign-offs, what to
flag, what to escalate.

Persona surfaces:

- **Soul files** — declarative personality config (`personality`,
  `communication`, `working-style`).
- **Plutchik emotion model + Big Five traits** — internal state
  Persona uses to color responses without performing.
- **Behavioral signals** — `persona_signal({ kind: 'correction' })`
  etc. let Claude record what worked and what didn't, evolving the
  soul file over time.
- **Style mirroring** — picks up your patterns from the conversation
  (terse vs. exploratory, code-first vs. explained).

Released as `@onenomad/persona-mcp` on npm. Cortex pulls Persona for
tone shaping on outbound drafts (replies, briefs).

When to call Persona MCP tools directly:

- `persona_signal` after Claude does something well or poorly
- `persona_init` to bootstrap from a description
- `persona_apply` to render a response in your voice

## Synapse — cross-client bridge

The bus between concurrent Claude sessions. If you have Claude Code
open in one terminal and Claude Desktop on another machine, Synapse
lets them talk to each other.

Synapse delivers:

- **Multi-session messaging** — `synapse_send`, `synapse_poll`,
  `synapse_reply`, threads, broadcasts.
- **Identity persistence** — peer-id stays stable across daemon
  restarts; alias chains so old IDs auto-redirect (§1.6).
- **Recruitment** — broadcast a need, the right idle peer auto-joins
  the thread.
- **Capabilities advertisement** — peers declare what they can do so
  recruitment can target.

Synapse is independent of Cortex / Engram / Persona — entirely
opt-in. If you only run a single Claude session at a time, you don't
need it.

→ Synapse is a separate repo; ask the project maintainer for access if you want to install it.

---

## How they compose

A typical day exercises the stack like this:

1. **Morning brief** — Cortex's scheduler fires at 8am. Pulls today's
   meetings (Calendar adapter), priority action items (queries
   Engram), recent decisions (Engram). Persona shapes the message.
   Slack-DM posted to your self-channel.
2. **Pre-meeting brief** — 30 min before each calendar event,
   Cortex's scheduler queries Engram for prior meetings with these
   attendees, open commitments, relevant docs. Brief lands in Slack.
3. **Note-taking** — open `localhost:3030/notes`, write a markdown
   note. Cortex saves it to your Obsidian vault. Obsidian adapter
   re-ingests it into Engram. Searchable from `/search` immediately.
4. **Search-during-conversation** — Claude calls Cortex's
   `search_related` to find prior context before recommending. Cortex
   asks Engram, returns top-N memories.
5. **End of day** — Cortex prompts at 5pm with open commitments. You
   mark done / snoozed / dropped. The summary writes a session
   handoff via Engram for tomorrow's morning brief to pick up.

If you have Claude Code + Claude Desktop both open, Synapse keeps
them coordinated. Otherwise it's the same flow without Synapse in
the loop.

---

## Independence

- **Cortex requires** Engram (or `@onenomad/cortex-memory-pgvector`
  fallback). Persona is optional; without it, drafts use a default
  voice.
- **Engram is fully standalone.** Connect Claude directly if you
  want a memory-only setup.
- **Persona is fully standalone.** Connect Claude directly if you
  want voice/style without Cortex's adapters.
- **Synapse is fully standalone.** Connect any two Claude sessions
  via Synapse without any of the other three.

The MCP composition keeps each layer focused: Engram doesn't know
about projects, Persona doesn't know about meetings, Synapse doesn't
know about either. Cortex is where domain shape lives.
