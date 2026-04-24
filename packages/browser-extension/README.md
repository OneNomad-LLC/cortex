# @onenomad/cortex-browser-extension

Ingest web content (Slack, Outlook, Teams, or any page) into your local
Cortex instance. Because Claude Code is already MCP-connected to Cortex,
anything ingested here becomes available to Claude right away.

## Quick start

```bash
# From the cortex repo root
pnpm install
pnpm --filter @onenomad/cortex-browser-extension build
```

Then load the unpacked extension into Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Pick `packages/browser-extension/dist/`

The extension talks to `http://localhost:4141` by default (the Cortex
dashboard API). If you run the sidecar on a different port, change the
base URL from the popup's "API base" field — it's stored in
`chrome.storage.sync` so it persists.

## How it's used

- **Select text on any page** → floating `⊕ Cortex` button appears
  near the selection → click to ingest.
- **Right-click** → `Ingest selection to Cortex` or
  `Ingest thread to Cortex` (runs the page-specific extractor).
- **Toolbar icon** → opens a popup with project / type / tags
  controls, an extract preview, and recent ingests.

Per-site DOM extractors:

| Host                             | Extractor           |
| -------------------------------- | ------------------- |
| `app.slack.com` (workspace)      | Slack               |
| `outlook.office.com` / live.com  | Outlook Web         |
| `teams.microsoft.com` / live.com | Teams               |
| Everything else                  | Readability-ish fallback |

## Dev loop

```bash
pnpm --filter @onenomad/cortex-browser-extension dev
```

Vite serves HMR for the popup. For the content + background scripts
the CRX plugin rebuilds into `dist/` — Chrome auto-reloads the
extension when the manifest hash changes.

## What the extension needs from Cortex

- `POST /api/mcp/tools/ingest_content/invoke` — the ingest endpoint.
- `POST /api/mcp/tools/list_projects/invoke` — project picker source.
- `GET  /health` — status dot ping.

CORS for `chrome-extension://` is wired on the Cortex side, so no
additional server config is required.

## Roadmap

- Phase 2 (not built yet): agentic browser-control tools exposed over a
  WebSocket bridge so Cortex can steer the browser from Claude.
