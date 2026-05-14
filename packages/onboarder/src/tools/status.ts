import { z } from 'zod'
import { getMcpServer, CLAUDE_CONFIG_PATH } from '../lib/mcp-config.js'

export const cortexStatusInputSchema = z.object({
  mcpName: z
    .string()
    .default('cortex')
    .describe('Name of the MCP server entry to inspect.'),
  probe: z
    .boolean()
    .default(true)
    .describe('Hit the configured URL with the bearer to confirm it answers and the bearer is still valid.'),
})

export type CortexStatusInput = z.infer<typeof cortexStatusInputSchema>

export interface CortexStatusOutput {
  configured: boolean
  url?: string
  reachable?: boolean
  reachableDetail?: string
  configPath: string
}

export async function cortexStatus(input: CortexStatusInput): Promise<CortexStatusOutput> {
  const entry = await getMcpServer(input.mcpName)
  if (!entry) {
    return { configured: false, configPath: CLAUDE_CONFIG_PATH }
  }
  const out: CortexStatusOutput = {
    configured: true,
    url: entry.url,
    configPath: CLAUDE_CONFIG_PATH,
  }
  if (!input.probe) return out

  const auth = entry.headers?.Authorization
  if (!auth) {
    out.reachable = false
    out.reachableDetail = 'no Authorization header on the entry — probably configured by hand'
    return out
  }
  try {
    // initialize is the cheapest legal MCP request that exercises auth
    // + transport without side-effects.
    const res = await fetch(entry.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        Authorization: auth,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cortex-onboarder', version: '0.1.0' },
        },
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      out.reachable = true
      out.reachableDetail = `HTTP ${res.status}`
    } else {
      out.reachable = false
      out.reachableDetail = `HTTP ${res.status}`
    }
  } catch (err) {
    out.reachable = false
    out.reachableDetail = err instanceof Error ? err.message : String(err)
  }
  return out
}
