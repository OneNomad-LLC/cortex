# @onenomad/cortex-onboarder

One-time MCP server that handles Cortex login and writes the per-tenant
Cortex MCP entry into your Claude Code config. After installing this
once, signing into a Cortex tenant becomes a chat command — no more
copy/pasting bearer tokens or editing config files.

## Install

```bash
claude mcp add cortex-onboarder -- npx -y @onenomad/cortex-onboarder
```

That's it. Restart Claude Code so the onboarder loads.

## Usage

In any Claude Code session, just say:

> log me into Cortex at https://pyre.sh

Claude calls `cortex_login`, which opens your browser to confirm,
writes the resulting MCP entry, and tells you to restart. After
restart you have the full Cortex toolset (`cortex_search`,
`ingest_content`, `digest`, etc.) bound to your tenant.

## Tools

- **`cortex_login`** — Run the device-code login flow. Opens browser,
  polls for approval, writes Claude Code MCP config under the given
  name (default `cortex`).
- **`cortex_logout`** — Remove the named Cortex MCP entry.
- **`cortex_status`** — Check whether a Cortex MCP is configured and
  (optionally) probe the URL to confirm it answers.

## Why this exists

The chicken-and-egg problem: a tool that logs you into Cortex MCP can't
live on the Cortex MCP server itself, because at the moment of first
login, that connection doesn't exist yet. The onboarder is a separate,
secret-free MCP that you install once. From then on, login / switch
tenant / logout are all chat commands instead of terminal copy-paste.

## License

Apache-2.0. See the repository LICENSE.
