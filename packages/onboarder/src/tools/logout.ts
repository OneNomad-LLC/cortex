import { z } from 'zod'
import { removeMcpServer, CLAUDE_CONFIG_PATH } from '../lib/mcp-config.js'

export const cortexLogoutInputSchema = z.object({
  mcpName: z
    .string()
    .default('cortex')
    .describe('Name of the MCP server entry to remove from Claude Code config.'),
})

export type CortexLogoutInput = z.infer<typeof cortexLogoutInputSchema>

export interface CortexLogoutOutput {
  ok: boolean
  message: string
}

export async function cortexLogout(input: CortexLogoutInput): Promise<CortexLogoutOutput> {
  const removed = await removeMcpServer(input.mcpName)
  if (!removed) {
    return {
      ok: true,
      message: `No "${input.mcpName}" MCP entry was registered. Nothing to do.`,
    }
  }
  return {
    ok: true,
    message: `Removed "${input.mcpName}" from ${CLAUDE_CONFIG_PATH}. Restart Claude Code to drop the connection.`,
  }
}
