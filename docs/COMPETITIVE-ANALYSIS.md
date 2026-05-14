# Cortex — Competitive Market Analysis

**Prepared:** May 2026
**Author:** Strategic analysis for OneNomad / Cortex
**Scope:** Strategic positioning + investor / fundraising readiness
**Cortex version analyzed:** 0.2 (post-MCP enrichment-protocol split)

---

## 1. Executive Summary

Cortex is a self-hosted, MCP-native **knowledge engine for AI agents** that unifies a knowledge worker's docs, tickets, meetings, code, chat, email, and notes into a single retrievable layer that any MCP-aware AI client (Claude Code, Claude Desktop, custom agents) can query. It is built as an orchestration layer on top of Engram (memory + knowledge graph) and Persona (style + voice), with a pluggable LLM provider system, a local Next.js dashboard, and twelve shipped source adapters.

Cortex sits at the intersection of four markets that converged in 2024-2026:

1. **Enterprise knowledge search** (Glean, Atlassian Rovo, Notion AI, Microsoft 365 Copilot, Slack AI)
2. **AI memory / agent infrastructure** (Mem0, Zep, Letta, Cognee)
3. **Personal knowledge management with AI** (Mem.ai, Reor, Obsidian + Smart Connections / Copilot)
4. **Consumer AI assistants with memory** (ChatGPT Memory, Claude Projects, Gemini)

No incumbent occupies the position Cortex is building toward: **a composable, self-hosted, MCP-native knowledge OS that runs on a single user's machine, scales to a team, and lets any AI agent become the user's "second brain" without that data ever leaving the user's infrastructure.**

**The three strongest differentiation pillars:**

- **MCP-native from day one.** Cortex is not retrofitting MCP onto a SaaS product — it was designed for the protocol. As MCP solidifies as the de facto agent interface (Anthropic, OpenAI plugin manifest 2.4, Google's adoption), Cortex inherits compounding optionality.
- **Data plane / compute plane split.** Cortex Core runs with **zero LLM**. Enrichment is delegated to a connected MCP client (Claude Desktop, Pyre, custom agent) via the Cortex Enrichment Protocol, or to a pluggable in-process provider. This is genuinely novel and lowers the operational floor to "you already have Claude Desktop, you have enrichment."
- **Local-first, on-prem by default.** Twelve adapters ingest into a user's own machine. Memory backend is pluggable (Engram or native Postgres + pgvector). No vendor lock-in. No data egress. No SaaS contract.

**The three biggest gaps:**

- **No GTM motion or distribution.** Solo-built, private repo, no marketing site, no growth funnel.
- **Setup friction is high.** Node, pnpm, Docker, Tailscale, Postgres, OAuth flows, YAML configs — orders of magnitude harder than "sign up to Glean."
- **Multi-user / team features are roadmapped but unshipped.** Federation (`@onenomad/cortex-memory-remote`) is ADR-only. Today Cortex is a power-user product, not a team product.

**Strategic recommendation:** Anchor Cortex's first commercial wedge in **the developer / AI-power-user segment** — people already running Claude Code and Claude Desktop, already using MCP, already invested in agentic workflows, who need a serious memory and knowledge layer they actually control. From there, the natural commercial expansion is **on-prem self-hosted team deployments** (10-200 person companies in regulated industries — legal, healthcare, defense contractors, finance) where data sovereignty is non-negotiable and where Glean / M365 Copilot is rejected because of cloud-only architecture.

The investor narrative is that the agent-economy needs a knowledge layer that is **owned by the user, not the vendor** — and Cortex is the only such layer that is MCP-native, composable, and shipping today.

---

## 2. Cortex Today — Honest Feature Inventory

The brief is honest about state. Most of what follows is shipped and tested; a few items are roadmapped and marked as such.

### Shipped (verified against repo state, 2026-05-12)

**Source adapters (12):** Confluence, Jira, Linear, Loom, Notion, Obsidian, Google Calendar, Google Drive, Gmail, Bitbucket, GitHub, Slack. All implement the same `SourceAdapter` contract (fetch / transform / classify / ingest). Atlassian and Google Calendar adapters support `discoverProjects` for auto-import.

**Pipelines (5):** doc (heading-based chunking), meeting (3-pass structural → synthesis → brief), code (language-aware chunking, tree-sitter), conversation (thread + per-day + quotes), research (two-pass extract → brief). All run rule-based by default; LLM passes are skipped gracefully when no provider is configured.

**MCP tool surface (~30 tools):** project context, knowledge search, action items, digests, briefs, notes CRUD, session handoffs, workspace switching, identity, enrichment protocol, ingestion (content / file / repo / URL), knowledge-base management. Tools are independently testable, one per file.

**Memory backend:** Engram (primary, stdio subprocess) + `@onenomad/cortex-memory-pgvector` (native Postgres + pgvector + tsvector hybrid search via RRF) as health-check fallback. `@onenomad/cortex-memory-remote` skeleton ready for federated personal-local + shared-team Engram (ADR-016 pending).

**LLM provider layer:** pluggable, per-task routing. Ollama (local) and OpenRouter (cloud aggregator BYOK) shipped. Anthropic / OpenAI / Google direct providers on roadmap. **Or no LLM at all** — Cortex 0.2's Enrichment Protocol delegates LLM work to the connected MCP client.

**Dashboard (Next.js 15 + shadcn/ui):** today timeline, notes editor (TipTap), semantic search, eight-widget grid (priorities, today-meetings, upcoming-briefs, my-action-items, recent-decisions, recent-activity, code-activity, who-knows), settings, MCP console, adapter/provider/module config forms, status/logs. Layout YAML-driven with role presets. Per-user, localhost-only.

**Workspaces:** Multiple isolated contexts (work / personal / side projects) under `~/.cortex/workspaces/<slug>/`, each with its own config / `.env` / memory state. Switchable from CLI, MCP, or dashboard.

**Notifications dispatcher:** Slack DM-based morning brief (08:00), pre-meeting brief (T-30 per calendar event), end-of-day capture (17:00). Configurable per workspace.

**Ingestion paths:** cron-based scheduler (every enabled adapter), `stream()` (Obsidian chokidar file watcher), `webhook()` (GitHub push events, Slack — HMAC-verified). `cortex import meeting <file>` for manual transcript ingestion.

**Operational tooling:** `cortex doctor [--connect]` pre-flight check, `cortex sync <adapter>` one-shot, `cortex smoke` live provider probe, multi-stage Dockerfile, docker-compose with pgvector / Ollama profiles, HTTP MCP transport for remote deployment, Tailscale-friendly architecture, PII hygiene pre-commit hook, memory governance metadata (trust / sensitivity / status / trace_id) on every ingest, SQLite read-model cache for dashboard widgets (2-5s → sub-100ms).

**Bridge for multi-client work:** session handoff tools (`leave_session_handoff`, `read_session_handoffs`, `resolve_session_handoff`) let Claude Code, Claude Desktop, and Claude in Chrome pick up where each other left off.

### Roadmapped (not yet shipped)

- **Federation (ADR-016)** — `@onenomad/cortex-memory-remote` for hybrid personal-local + shared-team Engram. This is the unlock for team / multi-user deployment.
- **Engram `reference` cognitive layer (ADR-002)** — long-tail work reference (Confluence docs, ADRs, code) that doesn't decay like episodic memory.
- **Wizard-spec-driven admin forms** — finish the dashboard's setup/configure UI path (widget grid is done; forms aren't).
- **Live smoke** against real Confluence and real Google OAuth consent.
- **Anthropic / OpenAI / Google direct provider packages** — currently routed through OpenRouter.

### Notable absences (relevant to competitive analysis)

- No mobile or native desktop client (web dashboard only)
- No multi-tenant team server (single-user-per-install today)
- No SOC 2 / ISO 27001 / HIPAA bundle, no DPA template, no enterprise admin console
- No paid support, customer success, or onboarding service
- No public marketing site, no pricing page, no commercial GTM
- No SCIM / SAML / SSO for enterprise identity
- No usage telemetry or analytics (deliberate, but limits product feedback)

---

## 3. Market Landscape

### 3.1 The four segments and how they relate

```
                        AI knowledge access spectrum
                        
                  Personal  ───────────────────────  Enterprise
                  
  Consumer AI                Personal PKM            AI Memory Infra            Enterprise Search
  (with memory)                                                                  
                                                                                 
  ChatGPT Memory             Mem.ai                  Mem0                       Glean ($7B val)
  Claude Projects            Reor                    Zep                        Atlassian Rovo
  Gemini Memory              Obsidian + AI plugins   Letta (MemGPT)             Microsoft 365 Copilot
  Microsoft Copilot          Notion (personal)       Cognee                     Notion AI Enterprise
                                                     LlamaIndex memory          Slack AI
                                                                                Coveo, Elastic
  
  ↑ vendor-controlled                                                           ↑ vendor-controlled
  ↑ closed                                                                      ↑ closed-ish
  ↑ data shared with vendor                                                     ↑ data shared with vendor
  ↑ "you are the product"                                                       ↑ "your data trains their AI"
  
                            ⟵   CORTEX sits across all four   ⟶
                            
                            self-hosted · MCP-native · BYO-LLM · composable
```

**The shape of the market:**

- **Enterprise knowledge search** is the largest revenue pool ($3-5B globally in 2026 by analyst consensus, growing 30%+ YoY since the Glean breakout). Buyers are CIOs and CISOs. Deals are $50-500K ACV. **All four leaders are SaaS-only.** This is the moat Cortex's on-prem story attacks.
- **AI memory infrastructure** is small in revenue today but is the fastest-growing developer category — Mem0 raised on it, Zep raised on it, Letta raised on it, Cognee raised $7.5M seed (Apr 2026). These products are **SDKs**, not workflow systems. They compete with Engram (Cortex's memory layer), not with Cortex itself.
- **Personal PKM with AI** is mature but fragmented. Mem.ai represents the "AI organizes for you" thesis; Obsidian + AI plugins represent the "local file + plugins" thesis. Cortex is more capable than either but heavier to set up.
- **Consumer AI memory** is a feature, not a product. ChatGPT, Claude, Gemini, and Copilot all built it because retention demanded it. These are **distribution channels for Cortex, not competitors**.

### 3.2 Where Cortex actually plays — and where it doesn't

| Segment | Cortex competes? | Cortex's role |
|---|---|---|
| Enterprise knowledge search | Yes, with caveats | The self-hosted, MCP-native alternative for orgs that reject SaaS |
| AI memory / agent infra | Yes, via Engram | Engram = the memory layer; Cortex = the orchestration on top |
| Personal PKM with AI | Yes | The power-user, multi-source alternative to Mem.ai / Reor / Obsidian |
| Consumer AI with memory | No — complements | Cortex extends Claude / ChatGPT memory with company-grade ingestion |

The honest framing: **Cortex is not trying to be Glean**. Cortex is trying to be the answer to "what do I install when I want Glean's outcome but my data, my LLMs, and my MCP-native agents?"

---

## 4. Segment 1 — Enterprise Knowledge Search

### 4.1 Glean

The category leader, founded 2019, ~$7B valuation as of 2025-26, hundreds of enterprise customers. Glean is what Cortex looks most architecturally similar to from the outside — both unify dozens of SaaS sources, both expose chat + search, both build a knowledge graph.

The differences are the entire story:

| Dimension | Glean | Cortex |
|---|---|---|
| Deployment | SaaS only (their cloud) | Self-hosted by default; Docker / Hetzner / Tailscale |
| Pricing | ~$50+/user/month, 100-seat minimum; reported ACVs $60K-$240K base, $350K-$480K fully loaded | Free / open / TBD commercial |
| Time-to-value | Days-to-weeks with vendor SE | Hours, self-driven, but high friction |
| Connectors | 100+ | 12 |
| AI Assistant | Glean Assistant included; Agents tier extra | Any MCP client (Claude Code/Desktop, Pyre, custom) |
| LLM | Proprietary RAG, models not user-controlled | BYO Ollama, OpenRouter, any MCP-aware client |
| Memory model | Per-session RAG retrieval, no persistent memory of user | Persistent (Engram), graph-aware, workspaces |
| Identity / SSO | SCIM / SAML / OIDC | None today |
| Compliance | SOC 2 Type II, ISO 27001, HIPAA available | None |
| MCP support | Reported MCP server (vendor-led, 2025) | Native, designed-around |
| Customer base | Mid-market and enterprise | Solo / power-user |

**Where Glean wins today:** Procurement-friendly, polished, supported, complete connector catalog, identity bundle, audit trails, sales-led delivery. For a 5,000-person company, Glean is a defensible choice.

**Where Cortex can take share over time:** Companies that refuse SaaS for IP, regulatory, or sovereignty reasons; AI-power-user developer teams who already live in Claude Code; mid-sized regulated firms (healthcare, finance, legal, defense, government contractors) where data residency is a board-level concern; cost-sensitive 50-500 person teams who choke on $240K Glean ACVs.

**Threat from Glean:** If Glean opens a strong self-hosted tier (rumored at re:Invent 2025 but not announced), the on-prem moat narrows. Watch this closely.

### 4.2 Atlassian Rovo

Rovo went GA in late 2024 and reached 5M MAU by early 2026, automating 2.4M workflows in a six-month window. Three components: Chat (Q&A across Atlassian + connected SaaS), Agents (task automation), Studio (custom agent builder). Pricing is "$0 incremental" inside eligible paid Atlassian Cloud plans, then credit-based usage (25 / 70 / 150 Rovo credits per user per month on Standard / Premium / Enterprise), with Rovo Dev at $20/dev/mo for 2,000 credits.

**Where Rovo wins:** Atlassian-shop default. If a customer is already on Jira + Confluence Cloud, Rovo is preinstalled and pre-paid.

**Where Cortex differentiates:** Rovo only sees the Atlassian + a handful of connected SaaS sources. Cortex bridges 12 sources (including non-Atlassian: GitHub, Slack, Gmail, Loom, Obsidian, Notion, Linear). Rovo agents are cloud-only and Atlassian-controlled. Cortex agents are any MCP client the user trusts.

**Threat from Rovo:** Atlassian's biggest competitive lever isn't AI quality — it's that they own Jira and Confluence and can charge $0 incremental. Many Cortex-relevant users are still Atlassian customers; Rovo "good enough" defeats Cortex "better but more work" for that buyer.

### 4.3 Microsoft 365 Copilot + Graph Connectors

Microsoft's distribution monster. 100+ prebuilt connectors (Box, Confluence, Google services, MediaWiki, Salesforce, ServiceNow, etc.). Synced connectors ingest into Microsoft Graph; federated connectors (early access) connect live. Copilot Search is a universal layer across M365 + connected sources. Plugin manifest schema 2.4 (2026) added **first-class MCP server support**, semantic file references, and improved OAuth flows.

**Where Microsoft wins:** Every Office customer can flip Copilot on. Connector catalog rivals Glean. Now MCP-aware. Distribution is unbeatable.

**Where Cortex differentiates:** Cortex serves users who are *not* M365-centric — devs on Google Workspace + Slack + Linear + GitHub. Cortex doesn't require an Office tenant. Cortex's data plane is portable across clouds; Copilot's isn't. Cortex composes any MCP client; Copilot is a single MCP client. Cortex stays on-prem by default.

**Threat from Microsoft:** Largest of the four. If Copilot bundles MCP server + connector aggregation cheaply enough, individual self-hosted plays get squeezed in the middle market. Mitigation: focus on the population that doesn't / won't use M365.

### 4.4 Notion AI

Notion bundled AI into Business and Enterprise tiers in early 2026 (Business: $18/user/mo, Enterprise: custom). New Free / Plus users can no longer buy the AI add-on. Connectors as of April 2026: Slack, Google Drive, GitHub, Jira, Microsoft Teams, OneDrive, SharePoint, Salesforce, Box. "Ask Notion" provides cross-workspace Q&A with citations.

**Where Notion wins:** Already-Notion-shops get a passable answer for free. Q&A UX is polished.

**Where Cortex differentiates:** Cortex is not bound to Notion as the canonical home. Cortex treats Notion as one of twelve sources. Cortex doesn't force users to migrate notes to Notion. Cortex doesn't hold notes hostage to a SaaS contract.

**Threat from Notion:** Limited. Notion is a great PKM-with-AI for Notion-native teams but isn't trying to be a general knowledge OS.

### 4.5 Slack AI, Coveo, Elastic Enterprise Search

These round out the segment but compete narrowly. Slack AI answers questions within Slack and is now bundled. Coveo and Elastic serve traditional enterprise search (websites, internal portals, customer-facing) and have started bolting on RAG. None compete head-on with Cortex's MCP-native + multi-source + agentic positioning.

### 4.6 Segment 1 capability matrix

Ratings: Strong / Adequate / Weak / Absent.

| Capability | Glean | Rovo | M365 Copilot | Notion AI | Cortex |
|---|---|---|---|---|---|
| Connector breadth | Strong (100+) | Adequate (Atlassian + few SaaS) | Strong (100+) | Adequate (~9) | Adequate (12, growing) |
| Self-hosted / on-prem | Absent | Absent | Absent (cloud-only) | Absent | **Strong** |
| MCP-native | Adequate (bolt-on 2025) | Adequate | Adequate (manifest 2.4) | Weak | **Strong** |
| BYO LLM | Absent | Absent | Absent (Azure OpenAI bound) | Absent | **Strong** |
| Pricing transparency | Weak (custom quote) | Adequate (per-credit) | Adequate (per-user) | Strong | **Strong** (free) |
| Identity / SSO | Strong | Strong | Strong | Strong | Absent |
| Compliance bundle | Strong | Strong | Strong | Strong | Absent |
| Enterprise admin | Strong | Strong | Strong | Strong | Weak |
| Mobile / native | Strong | Strong | Strong | Strong | Absent (web only) |
| Cross-source unified search | Strong | Adequate | Strong | Adequate | Strong |
| Persistent user memory | Weak (per-session RAG) | Weak | Weak | Weak | **Strong** (Engram + workspaces) |
| Workflow automation | Strong (Agents) | Strong (Agents) | Strong (Agents) | Adequate | Adequate (via MCP client) |

---

## 5. Segment 2 — AI Memory / Agent Infrastructure

### 5.1 The category

This category emerged 2023-25 to answer one question: how does a stateless LLM remember? The answers vary — some use vectors, some use graphs, some use hybrids, some build temporal models. They are **SDKs and infrastructure**, not end-user products. Their buyers are developers building agentic apps.

Cortex competes here through **Engram** (which is a standalone published npm package: `@onenomad/engram-memory`). Cortex itself wraps Engram with domain-specific orchestration — that's an entirely separate value prop.

### 5.2 Mem0

The most-cited memory layer in 2026. Open-source SDK with hosted cloud tier. Hybrid storage (vector + graph + key-value). Benchmarks show 26% higher accuracy than OpenAI's memory at 91% lower latency, and 90% token cost savings. Free tier: 10K memories + 1K retrievals/month. Pro: $19-$249/month. Supports 21+ frameworks and 4 LLM providers (OpenAI, Anthropic, Gemini, Ollama).

**Strengths:** Excellent benchmark story, clean developer DX, broad framework coverage.

**Weaknesses:** SDK only — no source adapters, no dashboard, no notifications, no end-user surface.

**Vs Cortex / Engram:** Mem0 is direct competition for Engram. Mem0 doesn't have the four-layer cognitive model (episodic / semantic / procedural / reference) Engram is building toward (ADR-002). Mem0 doesn't have memory governance metadata. But Mem0 has distribution, brand, and benchmarks; Engram has architectural ambition and is fewer steps from a research-grade memory primitive.

### 5.3 Zep

Temporal knowledge graph for agent memory. Open-source Graphiti engine + Zep Cloud managed service. Stores every fact as a graph node with start / end validity. Sub-200ms retrieval, voice-AI tuned. Credit-based pricing.

**Strengths:** The temporal graph model is unique. Strong for "what did the user say last Tuesday?" — true historical reasoning. Graphiti is well-engineered.

**Weaknesses:** Self-host requires provisioning Neo4j / FalkorDB / Kuzu — operational overhead. Community Edition deprecated April 2025; further feature retirements Feb 2026 — trust signal for self-hosters.

**Vs Cortex / Engram:** Both Engram and Zep have knowledge-graph cores. Zep's bet is temporal; Engram's bet is cognitive-layered. Different design philosophies. A composable Engram-on-Zep would be a credible v3, but for now Engram + Cortex's MCP-native composition is the differentiator.

### 5.4 Letta (formerly MemGPT)

UC Berkeley spin-out. Tiered memory inspired by computer architecture (Core / Recall / Archival). Context Repositories (2026): programmatic context management with git-style versioning. Letta Code: #1 model-agnostic open-source agent on Terminal-Bench. Free tier; paid from $20/month.

**Strengths:** Strong research pedigree. Genuine OS-style abstractions. Model-agnostic. Letta Code as a category leader is a credibility halo.

**Weaknesses:** Framework-shaped, not workflow-shaped. Best fit if you're building an agent product, less fit if you want a turnkey "ingest my work life" tool.

**Vs Cortex:** Letta is at a higher abstraction layer (an agent OS). Cortex could in principle build *on* Letta. They aren't direct competitors today, but if Letta's hosted product evolves into a "Letta-built second brain," they'd cross paths.

### 5.5 Cognee

$7.5M seed (April 2026). Graph-native semantic memory. Four-verb API (remember / recall / forget / improve). MCP server. ECL pipeline (Extract → Cognify → Load) ingests 38+ sources. Memify layer with feedback-loop refinement.

**Strengths:** Memory + sources in one box (38+ sources is more than Cortex's 12). MCP-native. Graph-first. Cleanest model for "self-improving memory."

**Weaknesses:** Hosted-first today; on-prem story less developed. SDK shape, not workflow-product shape.

**Vs Cortex:** **Cognee is the most architecturally similar competitor in the entire landscape.** Both ingest, both build graphs, both expose MCP, both feed agents. Differences: Cortex has 5 specialized pipelines (meeting, code, doc, conversation, research) vs Cognee's unified ECL; Cortex has workspaces; Cortex has the data-plane / compute-plane split (no LLM required at all). Cognee has more sources but Cortex has deeper sources (meeting pipeline does 3-pass extraction). Watch Cognee closely — if they ship workspaces and on-prem first-class, they collapse Cortex's wedge.

### 5.6 Segment 2 capability matrix

| Capability | Mem0 | Zep | Letta | Cognee | Engram (Cortex) |
|---|---|---|---|---|---|
| Vector retrieval | Strong | Adequate | Strong | Strong | Strong |
| Knowledge graph | Adequate | Strong (temporal) | Weak | Strong | Adequate (KG layer) |
| Cognitive layering | Weak | Weak | Strong (3-tier) | Adequate | Strong (4-layer + reference) |
| Memory governance | Weak | Adequate | Adequate | Adequate | Strong (trust / sensitivity / status) |
| Source adapters | Absent | Absent | Absent | Strong (38+) | Strong (12, via Cortex) |
| MCP-native | Adequate | Adequate | Adequate | Strong | **Strong** |
| Self-host | Strong (OSS) | Adequate (heavy deps) | Strong (OSS) | Adequate | **Strong** |
| Workspace isolation | Weak | Weak | Weak | Weak | **Strong** |
| Pricing | Free → $249/mo | Credit-based | Free → $20/mo | TBD | Free |
| Benchmarks public | Strong (LOCOMO) | Adequate | Strong (Terminal-Bench) | Weak | Absent |

The honest gap: **Cortex / Engram has no benchmark story.** This is the single highest-leverage piece of marketing to produce. LOCOMO, NIAH (Needle-in-a-Haystack), and Terminal-Bench scores would close credibility distance with Mem0 / Letta in weeks.

---

## 6. Segment 3 — Personal Knowledge Tools with AI

### 6.1 Mem.ai

"AI organizes for you" thesis. Free tier; Mem X $10/mo; Teams $15/mo. Mem Chat answers questions, summarizes, drafts; Smart Search NL queries; auto-categorization and -linking. Workflow Suggestions added in 2026.

**Strengths:** Lowest-friction onboarding in the category. Pretty product.

**Weaknesses:** Closed SaaS. Notes live on Mem's servers. No source ingestion (only manually-typed notes plus a handful of integrations). Limited extensibility.

**Vs Cortex:** Cortex is heavier but vastly more capable: 12 ingestion sources, your own server, multiple workspaces, MCP agent integration. Cortex is "Mem.ai for the developer / power user who refuses SaaS."

### 6.2 Reor

Open-source, local, Obsidian-style markdown files + AI. Ollama-friendly. Auto-linking, semantic search, RAG-style Q&A.

**Strengths:** Privacy-first. Local. Free. Stores plain markdown.

**Weaknesses:** Last meaningful update ~10 months ago — appears unmaintained. No source adapters. Single-user only.

**Vs Cortex:** Cortex offers what Reor offers (local, private, file-based) plus 12 sources, multi-workspace, agentic MCP integration, an active project. If a Reor user wants more, Cortex is the upgrade path.

### 6.3 Obsidian + Smart Connections / Copilot plugins

The dominant PKM platform with a sprawling plugin ecosystem. Smart Connections does embedding-based linking + RAG chat. Copilot (Logan Yang) is the polished local-LLM chat plugin (Ollama-native, Relevant Notes auto-context).

**Strengths:** Massive community, network effects, free, mature, every plugin imaginable.

**Weaknesses:** Each plugin is its own island. Source ingestion exists but is plugin-by-plugin and unreliable. No unified memory layer. No background ingestion. No MCP-native shape. No multi-source briefs.

**Vs Cortex:** Cortex is **what Obsidian + 6 plugins is trying to be**, but unified. In fact Cortex's Obsidian adapter means a user can keep Obsidian as the editor and use Cortex as the brain — best-of-both. This is a likely first commercial wedge: "Obsidian users who want their work life ingested too."

### 6.4 Notion (personal)

Notion is partly a PKM. Notion AI on personal plans gives Q&A inside Notion-owned content. Inferior to dedicated PKM tools for serious knowledge work but the connectors and integrations narrow the gap each quarter.

### 6.5 Segment 3 capability matrix

| Capability | Mem.ai | Reor | Obsidian + plugins | Notion AI | Cortex |
|---|---|---|---|---|---|
| Local data | Weak (cloud) | Strong | Strong (files) | Weak (cloud) | Strong |
| AI Q&A | Strong | Adequate | Adequate (via plugin) | Strong | Strong (via MCP client) |
| Source ingestion | Weak (manual) | Weak (manual) | Adequate (plugin chaos) | Adequate (connectors) | **Strong (12)** |
| Active development | Strong | Weak (stale) | Strong | Strong | Strong |
| Multi-workspace | Adequate | Weak | Weak | Adequate | **Strong** |
| MCP-native | Absent | Absent | Plugins emerging | Weak | **Strong** |
| Notifications / agent loop | Weak | Absent | Plugin-dependent | Weak | **Strong** |
| Setup friction | Strong (easy) | Strong (easy) | Adequate | Strong | **Weak** (high) |

The honest gap: **setup friction**. Mem.ai gets you running in 60 seconds. Cortex takes a power user 1-3 hours. The dashboard wizard work in flight (Sprint C polish) is critical — and a `cortex up` "install everything in one command" docker recipe should be marketed harder.

---

## 7. Segment 4 — Consumer AI Memory (Complements, Not Competitors)

ChatGPT Memory, Claude Projects, Gemini Memory, and Microsoft Copilot personal memory all do similar things: ingest hints from conversations, persist them in some form, surface them later. Cortex doesn't compete with these — **it extends them**.

| Product | Memory model | Cortex relationship |
|---|---|---|
| ChatGPT Memory | Implicit, ~40-80 stored facts, account-global | If user owns ChatGPT Plus / Team, Cortex serves them via custom GPT + MCP bridge |
| Claude Projects | Per-project memory, synthesized daily, user-controlled | **Native client.** Claude Code + Claude Desktop both speak MCP — Cortex's primary integration target |
| Gemini Memory | Account-level, opt-in personalization | Adjacent — Cortex's MCP server can be configured into Gemini's emerging MCP support |
| Microsoft Copilot | Per-user enterprise memory across M365 | Conflict if user is M365-bound; opportunity otherwise |

The **strategic implication**: consumer AI memory has anchored user expectation around "my AI knows me." Cortex's pitch becomes "your AI knows you *and your work*, on your hardware, on your terms." The bigger consumer memory gets, the bigger Cortex's adjacent market.

Watch carefully: ChatGPT and Claude **expanding memory persistence** (e.g. Claude's memory feature rollout, Sept 2025; ChatGPT's project memory tier matrix) reduces the perceived need for Cortex among casual users — but raises it among power users who realize their AI's memory is rate-limited and vendor-controlled.

---

## 8. SWOT

### Strengths

- **MCP-native architecture.** Not a feature; the core abstraction. As MCP adoption compounds (OpenAI Plugin Manifest 2.4, Anthropic / Google / Microsoft endorsement), Cortex inherits leverage.
- **Data-plane / compute-plane split.** No competitor has shipped the "zero-LLM data plane + protocol-delegated compute plane" pattern. This is genuinely defensible product.
- **Composability.** Engram, Persona, Cortex, Synapse are independent packages on npm. Users can adopt one without all. Lowers commitment cost.
- **Self-hosted by default.** Among 16+ competitors profiled, only Reor (unmaintained) and Cortex are truly local-first. Among actively-developed competitors, Cortex is the only one shipping on-prem + cross-source + agent-ready.
- **Twelve adapters today, growing.** Strong adapter contract means new sources are 1-day work, not 1-month projects. Roadmap velocity will compound.
- **Workspace isolation.** Per-context memory and config — the killer feature for consultants, multi-employer workers, and side-project owners.
- **Backed by real daily-driver use.** Single-user but real usage shapes the product against actual ADHD-class friction. Reduces the risk of building for hypothetical users.

### Weaknesses

- **Distribution.** Private repo. No site. No paid acquisition. No content engine. No social presence as a product.
- **Setup friction.** High for non-developers. Wizard work in flight but not finished.
- **No enterprise bundle.** No SOC 2, no SSO, no admin console, no DPA. Blocks enterprise procurement entirely.
- **No team / multi-user.** Federation is ADR only. Today a Cortex install is one human.
- **No benchmark story.** Mem0 has LOCOMO; Letta has Terminal-Bench. Cortex/Engram has nothing public. Critical credibility gap.
- **Solo build.** Bus-factor of one. No sustained eng velocity, no second perspective, no specialization.
- **Limited LLM provider menu.** Ollama + OpenRouter shipped; direct Anthropic / OpenAI / Google still on roadmap.
- **No mobile / native client.** Web dashboard + MCP clients only.
- **License posture unclear.** README says "Private project. Not for redistribution. Future commercial licensing TBD." This blocks community contribution and the "open-source moat" play.

### Opportunities

- **MCP becomes the agent protocol.** If MCP wins, Cortex is one of the few MCP-native end-user systems shipping. The narrative writes itself.
- **AI sovereignty trend.** EU AI Act, US state-level data residency laws, board-level fear of LLM data leakage. The market for "AI that runs on your hardware" expands rapidly through 2026-2028.
- **Glean / Microsoft pricing creates an opening for the middle market.** Companies of 50-500 people who can't justify $240K Glean ACVs are underserved. Cortex (self-hosted) at fraction of the price is a credible alternative *if* an enterprise bundle ships.
- **ADHD / neurodivergent professional segment.** Real, underserved, growing tooling category (e.g. Sunsama, Akiflow, Reclaim, Llama Life). Cortex's design choices (digest, brief, capture, prompt, workspaces) match this audience precisely.
- **Open-source distribution loop.** If `@onenomad/cortex` flips to a permissive license, GitHub stars / Hacker News / Show HN / Reddit / X are zero-cost distribution channels for technically-credible audiences.
- **Enterprise on-prem variant.** Hetzner / VPS / Tailscale-deployed multi-tenant Cortex is a paid SKU waiting to be packaged.
- **Marketplace economics.** Each adapter is a npm package. A "Cortex adapter marketplace" — paid premium adapters (Salesforce, Hubspot, ServiceNow, etc.) sold via Stripe — is technically a small lift.
- **Vertical-specific Cortex.** "Cortex for healthcare" (Loom-style consult ingest + Epic / Cerner connectors), "Cortex for law firms" (case file ingest + court calendar), "Cortex for investment teams" (deal flow + memos). Each vertical has $50K-$500K ACV potential.

### Threats

- **Glean ships a self-hosted tier.** Eliminates the on-prem moat. Highest-impact threat. Status: rumored, not confirmed.
- **Microsoft Copilot connector + MCP support deepens.** Bundling crushes the middle market.
- **Cognee ships workspaces and full on-prem.** Direct architectural collapse of Cortex's wedge.
- **Anthropic / OpenAI ship a native "memory + connectors" stack.** Consumer-grade competitors close the gap from above.
- **Atlassian acquires a memory infra startup** (Mem0 / Letta / Cognee at seed valuations). Rovo + acquired memory = Cortex-shaped but distributed by the most embedded ITSM/dev-tools vendor in the market.
- **MCP fails to dominate as expected.** If Google's A2A or another protocol displaces MCP, Cortex's architectural bet loses leverage. Low-probability but high-impact.
- **Engram / Persona project velocity slips.** Cortex depends on both. Single-builder dependency = compounding risk.

---

## 9. Strategic Positioning Recommendations

### 9.1 Positioning statement (proposed)

> **For** AI-power-user developers and knowledge workers
> **who** want their AI agents to remember their entire work life
> **Cortex is** a self-hosted, MCP-native knowledge OS
> **that** ingests their docs, tickets, meetings, code, chat, and notes into a memory layer that any AI agent can query.
> **Unlike** Glean, Notion AI, or M365 Copilot, Cortex runs on the user's own hardware and works with any LLM the user trusts — local or cloud.

### 9.2 Audience priority (proposed)

1. **Wedge: AI-power-user developers.** Already using Claude Code + Claude Desktop. Already in MCP. Already self-hosting some stack. Cortex is the obvious next install. Reach via HN, X, dev podcasts, /r/LocalLLaMA, /r/ClaudeAI.
2. **Expansion-1: Multi-context knowledge workers.** Consultants, freelancers, multi-employer ICs, people-with-side-projects. Cortex workspaces solve a real pain. Reach via Indie Hackers, Twitter / X dev community.
3. **Expansion-2: ADHD / neurodivergent professionals.** Active capture, brief, digest, prompt-loops match the operating system this audience needs. Reach via productivity newsletters, ADHD-positive YouTube, Sunsama-adjacent communities.
4. **Expansion-3: Regulated mid-market companies (50-500 ppl).** Healthcare, legal, finance, defense. Reject SaaS. Reach via vertical conferences, partnerships, design partners. Requires the enterprise bundle to ship first.

### 9.3 Messaging architecture

**Level 1 — Category claim.** "Knowledge OS for AI agents." Avoid "memory layer" (Mem0 / Zep / Letta own that) and "enterprise search" (Glean owns that).

**Level 2 — Primary differentiator.** "Self-hosted. MCP-native. Bring your own LLM."

**Level 3 — Value proposition.** "Your AI knows everything you do — without your data leaving your machine."

**Level 4 — Proof points.** 12 adapters. 5 pipelines. ~30 MCP tools. Eight dashboard widgets. Cron + webhook + stream ingestion. Multi-workspace. Active notifications. Pluggable memory + LLM. Open architecture. Composable with Claude Code, Claude Desktop, ChatGPT, Gemini.

### 9.4 What to build, accelerate, or deprioritize

**Build / accelerate (next 6 months):**
- License clarity — pick OSS or source-available, publish, communicate.
- Marketing site (single page is enough): one-line pitch, animated dashboard demo, "install in 60 seconds" Docker one-liner, MCP installation steps for Claude Code / Desktop.
- Benchmark suite — LOCOMO, NIAH for Engram; publish results vs Mem0 / Zep / Letta.
- `cortex up` true one-command install (Docker compose all-in-one, sensible defaults, OAuth-popup wizards).
- Ship federation (ADR-016). Unlocks teams. Unlocks paid commercial SKU.
- Direct Anthropic + OpenAI provider packages (close the menu).
- Reference videos: 3-minute "morning routine with Cortex," 5-minute "ingest your work life," 90-second "from `git clone` to first answer."

**Accelerate (next 12 months):**
- Enterprise bundle skeleton: SSO via OIDC, audit log, admin console, DPA template.
- Cortex Cloud (hosted variant for users who want zero-ops but still want the architecture). Different SKU from on-prem.
- First two paid premium adapters (Salesforce + HubSpot are the obvious pair).

**Deprioritize:**
- Mobile native client (use the dashboard + Slack DMs for now).
- Persona MCP polish (Persona is differentiation but second-order — finish Cortex first).
- Synapse (interesting but not on the critical path to revenue).
- "Cortex for X" vertical SKUs (premature; pick after the first 1,000 individual installs).

### 9.5 Where to differentiate vs. where to achieve parity

**Differentiate hard on:**
- Self-hosted + on-prem-first deployment story
- MCP-native + works with any MCP client
- Composability and architectural cleanliness (Engram + Persona + Cortex + Synapse)
- Workspace isolation
- Data-plane / compute-plane split

**Achieve parity on:**
- Source adapter breadth — match Glean's top 30 within 18 months
- Search quality — publish benchmarks, close the LOCOMO gap
- Onboarding speed — one-command install
- Identity / SSO basics (OIDC, then SAML, then SCIM)

**Don't try to compete on:**
- Brand and sales-led delivery (Glean wins here for at least 3 years)
- Connector catalog size (Microsoft has 100+, you'll never catch them; pick the 30 that matter)
- Mobile (native app is a multi-quarter distraction)
- Enterprise rolodex (don't try to sell to F500 in year one)

---

## 10. Investor Narrative

### 10.1 The thesis (one paragraph)

The AI agent economy needs a knowledge layer the user owns. Today, enterprise search is dominated by cloud-only SaaS (Glean, Notion AI, M365 Copilot) and AI memory is dominated by hosted SDKs (Mem0, Zep, Letta, Cognee). Both flanks lock the user's data, the user's LLM choice, and the user's agent choice into a single vendor. Cortex is the **first composable, self-hosted, MCP-native knowledge OS** that decouples those three choices. As MCP becomes the dominant agent protocol and data-sovereignty regulation expands, the market for user-owned knowledge infrastructure becomes the next zero-to-one venture category. Cortex is shipping today and 18 months ahead of where Glean's eventual on-prem variant or Microsoft's MCP-bundled play will be.

### 10.2 Market sizing (rough, defensible)

- **Enterprise knowledge search TAM** — $3-5B globally in 2026 (Gartner-class analyst consensus), 30%+ YoY growth since 2023. Glean's valuation puts a single-company SAM proxy at $7B+.
- **AI memory infrastructure** — $50-150M in 2026 ARR collectively (Mem0, Zep, Letta, Cognee). High-growth, low-penetration. Likely 100x by 2030.
- **PKM tools with AI** — ~$500M / year (Notion adjacent + Mem.ai + Roam + Obsidian Sync). Flat overall but high gross margin.
- **Cortex's serviceable obtainable market (5 years):**
  - 1,000 paid power-user seats × $10-50/mo = $0.1-0.6M ARR (year 1-2 wedge)
  - 100 mid-market team licenses × $5K-50K/yr = $0.5-5M ARR (year 2-3 expansion)
  - 10 enterprise on-prem deployments × $100K-500K/yr = $1-5M ARR (year 3-5)
  - **Combined 5-year SOM target: $5-15M ARR**, with optionality on Cortex Cloud + verticals taking it 3-10x higher

### 10.3 What makes this venture-scale

- **Compounding adapter economics.** Each adapter is a moat node. As adapters accumulate, switching cost to rebuild on a competitor grows.
- **MCP protocol leverage.** Every new MCP client (Claude Code, Claude Desktop, ChatGPT desktop with MCP, custom agents) is a Cortex distribution channel without a sale.
- **Hosted SKU economics.** Cortex Cloud has SaaS-class gross margins (~80%) while on-prem retains the "your data stays" narrative.
- **Marketplace optionality.** Paid premium adapters, third-party adapters, plugin economics.
- **Acquisition optionality.** Atlassian, Microsoft, Glean, Notion, Anthropic, OpenAI are all plausible acquirers. Acquisition price in the AI agent infra category trended at $50-300M for early seed/series A in 2024-25.

### 10.4 What the first $1M round buys

- Cofounder + 1-2 hires (eng, GTM/DevRel)
- Marketing site + 30-second demo + content engine
- Benchmark publication + technical credibility
- Wizard polish + one-command install
- Federation (ADR-016) shipped → team SKU live
- First 1,000 installs, first 100 paid seats

### 10.5 What the first $5M round buys

- Enterprise bundle skeleton (SSO, audit, admin, DPA)
- Cortex Cloud (hosted variant) shipped
- Second cohort of premium adapters (Salesforce, HubSpot, ServiceNow)
- First 10 mid-market design partners on team SKU
- Conference presence and analyst outreach

---

## 11. Risks and Watch List

### 11.1 Top-five risks ranked

1. **Glean or Microsoft ships a credible self-hosted MCP-native tier.** Single largest threat. Watch Glean's product blog, MS Ignite 2026, MS Build 2027.
2. **Cognee evolves into a workflow product.** They're closest architecturally and are funded. Watch their roadmap and GitHub.
3. **Solo builder burnout.** Mitigate by getting one technical cofounder before 2027.
4. **License ambiguity blocks community.** Resolve in Q3 2026. Strong recommendation: source-available with Polyform-style clauses, or AGPL with commercial exception, depending on acquisition optionality.
5. **MCP adoption stalls or fragments.** Monitor Google A2A, OpenAI's manifest evolution. Hedge by keeping Cortex's MCP layer behind a clean adapter so a second protocol can be added.

### 11.2 Competitive watch list (monthly cadence)

- **Glean** — `glean.com/blog`, hiring (look for "on-prem" / "self-hosted" / "MCP" titles)
- **Microsoft 365 Copilot** — `learn.microsoft.com/en-us/microsoft-365/copilot/release-notes`
- **Atlassian Rovo** — `atlassian.com/blog`, MAU + credit consumption disclosures
- **Notion** — `notion.com/releases` (especially connector additions)
- **Mem0** — `mem0.ai/blog`, GitHub releases
- **Zep** — `getzep.com/blog`, Graphiti GitHub
- **Letta** — `letta.com/blog`, Letta Code progress on benchmarks
- **Cognee** — `cognee.ai/blog`, GitHub roadmap, funding announcements
- **MCP ecosystem** — Anthropic blog, OpenAI plugin manifest changelog, Google's protocol announcements

---

## 12. Appendix — Cross-Segment Capability Matrix

Ratings: Strong / Adequate / Weak / Absent. "—" means not relevant to that competitor's market.

| Capability | Cortex | Glean | Rovo | M365 Copilot | Notion AI | Mem0 | Zep | Letta | Cognee | Mem.ai | Reor | Obsidian + AI | ChatGPT Memory | Claude Projects |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Self-hosted / on-prem | **Strong** | Absent | Absent | Absent | Absent | Strong | Adequate | Strong | Adequate | Absent | Strong | Strong | Absent | Absent |
| MCP-native | **Strong** | Adequate | Adequate | Adequate | Weak | Adequate | Adequate | Adequate | **Strong** | Absent | Absent | Emerging | Adequate | **Strong** |
| BYO LLM | **Strong** | Absent | Absent | Weak (Azure) | Absent | Strong | Strong | Strong | Strong | Absent | Strong | Strong | Absent | Absent |
| Source adapter count | 12 | 100+ | ~15 | 100+ | ~9 | 0 (SDK) | 0 | 0 | 38+ | minimal | 0 | plugin chaos | — | — |
| Persistent user memory | **Strong** | Weak | Weak | Weak | Weak | Strong | Strong | Strong | Strong | Adequate | Adequate | Plugin-dep | Adequate | Adequate |
| Knowledge graph | Strong | Strong | Adequate | Strong | Weak | Adequate | **Strong** | Weak | **Strong** | Weak | Weak | Weak | Weak | Weak |
| Workspaces | **Strong** | Weak | Adequate | Adequate | Strong | Weak | Weak | Weak | Weak | Weak | Weak | Weak | Adequate | **Strong** |
| Active notifications | **Strong** | Adequate | Adequate | Adequate | Adequate | Absent | Absent | Absent | Absent | Adequate | Absent | Plugin-dep | Absent | Absent |
| Mobile / native | Absent | Strong | Strong | Strong | Strong | — | — | — | — | Strong | Absent | Strong | Strong | Strong |
| Identity / SSO | Absent | Strong | Strong | Strong | Strong | Adequate | Adequate | Adequate | Adequate | Adequate | — | — | Adequate | Adequate |
| Compliance bundle | Absent | Strong | Strong | Strong | Strong | Adequate (SOC 2) | Adequate | Adequate | Adequate | Adequate | — | — | Adequate | Adequate |
| Public benchmarks | Absent | Weak | Weak | Adequate | Weak | **Strong** (LOCOMO) | Adequate | **Strong** (Terminal-Bench) | Weak | Weak | Absent | Absent | Adequate | Adequate |
| Setup friction (low = good) | Weak (high friction) | Strong | Strong | Strong | Strong | Strong | Adequate | Strong | Strong | Strong | Strong | Adequate | Strong | Strong |
| Composability with other tools | **Strong** | Weak | Weak | Adequate | Adequate | Strong | Strong | Strong | Strong | Weak | Adequate | Adequate | Weak | Adequate |
| Pricing transparency | **Strong** | Weak | Adequate | Adequate | Strong | Strong | Adequate | Strong | TBD | Strong | Strong | Free | Adequate | Adequate |

---

## 13. Closing Strategic Read

Cortex's architectural bets — **MCP-native, self-hosted, composable, BYO-LLM, workspace-isolated, data-plane/compute-plane split** — are individually credible and collectively unique. No other product in the 16-competitor scan combines more than two of these.

The product is **18 months ahead** of where the market will land in 2028 — and **18 months behind** where Glean, Notion, and Microsoft are on enterprise distribution. The strategic question is not "is the product good enough?" but "is the founder willing to pair the architecture with the GTM discipline required to convert it into a venture?"

Cortex's correct first move is **not** to compete with Glean for enterprise contracts. It is to win the AI-power-user developer cohort decisively in the next two to three quarters — license clarity, marketing site, benchmarks, one-command install, and federation. From a 5,000-developer base on a paid SKU, every adjacent expansion path (mid-market team, regulated industry, vertical SKU, Cortex Cloud, marketplace) opens up.

The risk is not the competition. The risk is staying invisible while the competition learns from the same architectural insights and ships them inside their existing distribution.

---

## Sources

- [Glean — Work AI for Enterprise](https://www.glean.com/)
- [Glean Pricing 2026 — CheckThat.ai](https://checkthat.ai/brands/glean/pricing)
- [Atlassian Rovo Features](https://www.atlassian.com/software/rovo/features)
- [Atlassian Rovo AI additions go GA — Constellation Research](https://www.constellationr.com/insights/news/atlassian-rovo-ai-additions-go-ga-consumption-pricing-deck)
- [Microsoft 365 Copilot connectors overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/overview)
- [Microsoft 365 Copilot release notes](https://learn.microsoft.com/en-us/microsoft-365/copilot/release-notes)
- [Notion AI Review 2026 — eesel](https://www.eesel.ai/blog/notion-ai-review)
- [Mem0 — The Memory Layer for your AI Apps](https://mem0.ai/)
- [State of AI Agent Memory 2026 — Mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Zep — Context Engineering & Agent Memory Platform](https://www.getzep.com/)
- [Letta (MemGPT) — letta.com](https://www.letta.com/)
- [Cognee — Model your agent's world](https://www.cognee.ai/)
- [Cognee MCP introduction](https://www.cognee.ai/blog/cognee-news/introducing-cognee-mcp)
- [Mem.ai Pricing](https://get.mem.ai/pricing)
- [Reor open-source PKM](https://openalternative.co/reor)
- [Obsidian Smart Connections + Copilot comparison](https://smartconnections.app/obsidian-copilot/)
- [ChatGPT vs Claude memory comparison — Simon Willison](https://simonwillison.net/2025/Sep/12/claude-memory/)
- [Claude Memory Setup Guide 2026](https://www.shareuhack.com/en/posts/claude-memory-feature-guide-2026)
