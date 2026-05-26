# @onenomad/przm-cortex

Cortex MCP server + CLI. Loads config, wires up providers and adapters,
schedules ingestion, and exposes work-specific tools to AI clients over MCP.

Ships the `cortex` bin:

```
cortex init    # interactive setup wizard (run this first)
cortex start   # boot the MCP server over stdio
cortex smoke   # live probe of every enabled LLM provider
cortex help    # usage
```

## Structure

- `src/cli/` — CLI entry and subcommands (`init`, `start`, `smoke`).
- `src/mcp/server.ts` — MCP server. Zero tools in Phase 1.
- `src/mcp/tools/` — one file per tool (filled in starting Phase 2).
- `src/clients/engram.ts` — typed wrapper over Engram MCP.
- `src/clients/persona.ts` — typed wrapper over Persona MCP.
- `src/registry/providers.ts` — loads enabled LLM providers, builds the router.
- `src/registry/adapters.ts` — loads enabled source adapters (stub).
- `src/scheduler.ts` — runs adapters on cron (stub).
- `src/config.ts` — loads and validates `config/cortex.yaml`.
- `src/logger.ts` — stderr-only structured logger (stdout is reserved for MCP).

## Running

```bash
pnpm --filter @onenomad/przm-cortex dev    # watch mode, runs `cortex start`
pnpm --filter @onenomad/przm-cortex build && pnpm --filter @onenomad/przm-cortex start
```

Tests:

```bash
pnpm --filter @onenomad/przm-cortex test       # unit
pnpm --filter @onenomad/przm-cortex test:int   # integration (requires live Ollama)
```
