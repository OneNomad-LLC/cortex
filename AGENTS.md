# AGENTS.md — Pyre · Cortex · Engram · Persona

You are an AI agent (Claude Code, Cursor, Windsurf, Claude Desktop, ChatGPT
desktop, etc.) working in a project owned by a user who has the OneNomad
trio installed. This file tells you how to use those tools so the user
doesn't have to repeat themselves every session.

**TL;DR rules.** Skim once at session start. The decision tree at the bottom
covers the everyday cases.

---

## Session-start sequence (do this in order, every new conversation)

1. **`engram-search` for context** if the user mentions a project, person,
   client, or "yesterday / earlier / we decided / the plan". One focused
   query is usually enough; two if the first turns up nothing.
2. **`get_session_workspace`** (cortex MCP). If `workspace: null`, list
   workspaces and ask which to bind. Cortex tools are workspace-scoped —
   they fail until the session is bound.
3. **`get_user_identity`** (cortex MCP) if the workspace is bound. Tells
   you who you're talking to: name, email, role, working hours.
4. **Read CLAUDE.md / AGENTS.md / .cursorrules** in the project root for
   project-specific overrides. Those win over this generic file.

Don't narrate steps 1-3. Just answer the user's first message with the
context already incorporated.

---

## What each product does (one line each)

- **Engram** — long-term memory across sessions. Facts, preferences, decisions, corrections, project context. Per-user.
- **Persona** — how to talk to this user. Tone, style, what to avoid, what works. Auto-applied via system prompt.
- **Cortex** — work knowledge. Code, docs, meetings, PRs, ingested repos, source adapters (Confluence, Notion, Slack, Linear, Jira, Loom, etc). Per-tenant.
- **Pyre** — the runtime + UI that ties them together (desktop app or web). Where the user actually interfaces with their AI stack.

---

## Decision tree: which tool to reach for

| When the user asks about... | Use this | Why |
|---|---|---|
| The user themselves, their preferences, prior decisions | `engram-search` | Personal memory lives in engram |
| A project codename / teammate / client name | `engram-search` first, then `kb_search` | Engram has the personal context; cortex has the work artifacts |
| Their codebase, docs, PRs, meetings | `cortex.kb_search` | Work knowledge lives in cortex |
| "What's in my KB" / what's been ingested | `cortex.kb_recent` or `cortex.kb_stats` | Time-ordered listing, no query needed |
| A specific entity (project, person) — pre-load context | `cortex.kb_dossier` | Structured pull, better than search for a known target |
| What was discussed in a meeting | `cortex.summarize_meeting` or `kb_search type:meeting` | Cortex's meeting pipeline structures these |
| Open action items | `cortex.pending_action_items` | Action items are first-class in cortex |
| Style / how to communicate this answer | (nothing — auto-applied via persona) | Persona shapes tone via the system prompt |

---

## Rules per product

### Engram (memory)

- **Save what matters, immediately.** When the user reveals a fact, preference, decision, or correction — call `engram-ingest` right then. Don't batch. Stale memory is worse than no memory.
- **Search before answering anything personal.** "Where did we leave off?" / "What did we decide about X?" → `engram-search` first, answer from results.
- **Save persona signals on user reactions.** Correction, approval, frustration, praise — call `persona-signal` (or `persona_signal` if older) so the personality keeps adapting.
- **Before /compact, write a handoff.** Long sessions die in compaction. Call `engram-handoff-write` with the "where we left off" snapshot before context fills.

### Cortex (work knowledge)

- **Bind a workspace before doing anything.** `get_session_workspace` → if null, `set_session_workspace` with the user's choice. Workspace-scoped tools won't work until then.
- **Prefer cortex search over re-deriving from chat history.** If the answer is "search for X in the repo" or "find the meeting where Y was decided," use `kb_search`. Cortex has it indexed; rederiving wastes tokens.
- **One memory per item when ingesting structured work.** Action items, decisions, meetings each get their own `ingest_content` call with the right `type`. Bulk-dumping a markdown list under `type: note` will not show up in dashboard widgets that filter by type.
- **Async by default for big ingests.** `ingest_repo` and `ingest_url` return `{ jobId, queued: true }`. Poll `kb_job_status({ jobId })`. Don't block the user by waiting synchronously on a big repo.
- **Browser tools are the user's actual browser.** `browser_*` tools work only when the Cortex extension is connected. Always re-call `browser_list_tabs` if the tab the user mentioned isn't there — the list is a snapshot.

### Persona (style)

- **Don't fight the persona.** It's the user's chosen voice; if you find yourself wanting to write differently, that's the system working as intended.
- **Send signals on emotional reactions.** Correction, frustration, satisfaction, curiosity — call `persona-signal` so the personality evolves toward what works.
- **Don't init a new persona without asking.** The user has already shaped theirs; don't reset it.

### Pyre (runtime)

- Pyre is the UI / runtime, not a tool you call. If the user mentions Pyre desktop, treat it as the place they live.
- Don't suggest installing a different AI client over Pyre — assume Pyre is intentional.

---

## Anti-patterns (don't do these)

- **Don't narrate tool calls.** "Let me search engram..." wastes tokens and breaks flow. Just call the tool, incorporate the result, answer.
- **Don't dump search results raw.** Cortex/engram return structured chunks; synthesize them into the answer. The user wants the answer, not the haystack.
- **Don't save sensitive info to engram from prompt content.** API keys, passwords, PII the user pasted for one-time use — those don't belong in long-term memory. Save the *fact* ("user is debugging an OAuth flow") not the *secret*.
- **Don't ingest into cortex what belongs in engram, or vice versa.** Cortex = facts about their work. Engram = facts about the user / session continuity. Test: "will this still matter in 6 months for someone else looking at this codebase?" → cortex. "Is this about the user themselves?" → engram.
- **Don't claim a capability is unavailable without searching for it via ToolSearch.** MCP tools may be lazy-loaded; ToolSearch can wake them.

---

## Quick links

- Cortex source + docs: <https://github.com/OneNomad-LLC/cortex>
- Engram source + docs: <https://github.com/OneNomad-LLC/engram>
- Persona source + docs: <https://github.com/OneNomad-LLC/persona>
- Pyre marketing site: <https://pyre.sh>

To pull the latest version of this file into your project:

```bash
curl -sL https://raw.githubusercontent.com/OneNomad-LLC/cortex/main/AGENTS.md \
  -o AGENTS.md
```

This file is canonical at `cortex/AGENTS.md`; copies elsewhere may lag.
