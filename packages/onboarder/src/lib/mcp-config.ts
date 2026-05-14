import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Reads + writes the Claude Code user-scope MCP config at
 * ~/.claude/config.json. Atomic-ish — read, mutate, write — same
 * pattern `claude mcp add` uses internally.
 *
 * Other MCP-aware clients (Claude Desktop, Cursor, Windsurf) live at
 * different paths; v1 supports Claude Code only. Adding others is a
 * matter of writing additional adapters in this file.
 */

export interface ClaudeCodeMcpEntry {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

interface ClaudeCodeConfig {
  mcpServers?: Record<string, ClaudeCodeMcpEntry>
  [key: string]: unknown
}

const CLAUDE_CONFIG_PATH = join(homedir(), '.claude', 'config.json')

async function readConfig(): Promise<ClaudeCodeConfig> {
  try {
    const raw = await fs.readFile(CLAUDE_CONFIG_PATH, 'utf8')
    return JSON.parse(raw) as ClaudeCodeConfig
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    throw err
  }
}

async function writeConfig(config: ClaudeCodeConfig): Promise<void> {
  await fs.mkdir(dirname(CLAUDE_CONFIG_PATH), { recursive: true })
  const json = JSON.stringify(config, null, 2)
  await fs.writeFile(CLAUDE_CONFIG_PATH, json + '\n', 'utf8')
}

export interface UpsertMcpInput {
  name: string
  url: string
  bearer: string
}

/**
 * Add or replace an MCP server entry. Idempotent — calling twice with
 * the same name overwrites, so re-login flows work cleanly.
 */
export async function upsertMcpServer(input: UpsertMcpInput): Promise<void> {
  const config = await readConfig()
  if (!config.mcpServers) config.mcpServers = {}
  config.mcpServers[input.name] = {
    type: 'http',
    url: input.url,
    headers: { Authorization: `Bearer ${input.bearer}` },
  }
  await writeConfig(config)
}

/**
 * Remove an MCP server entry. No-op if it wasn't there.
 */
export async function removeMcpServer(name: string): Promise<boolean> {
  const config = await readConfig()
  if (!config.mcpServers || !(name in config.mcpServers)) return false
  delete config.mcpServers[name]
  await writeConfig(config)
  return true
}

/**
 * Read an MCP server entry. Returns null when absent.
 */
export async function getMcpServer(name: string): Promise<ClaudeCodeMcpEntry | null> {
  const config = await readConfig()
  return config.mcpServers?.[name] ?? null
}

export { CLAUDE_CONFIG_PATH }
