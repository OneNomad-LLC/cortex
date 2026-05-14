import { z } from 'zod'
import open from 'open'
import { startDeviceFlow, waitForApproval } from '../lib/device-flow.js'
import { upsertMcpServer, CLAUDE_CONFIG_PATH } from '../lib/mcp-config.js'

export const cortexLoginInputSchema = z.object({
  serverUrl: z
    .string()
    .url()
    .describe(
      'Pyre server URL — typically https://pyre.sh for prod or your private deployment URL. Required; the onboarder intentionally has no default fallback so users do not accidentally point at the wrong control plane.',
    ),
  mcpName: z
    .string()
    .default('cortex')
    .describe(
      'Name to register the resulting MCP server under in Claude Code config. Defaults to "cortex"; override if you have multiple Cortex tenants and want them named separately.',
    ),
  openBrowser: z
    .boolean()
    .default(true)
    .describe('Whether to auto-open the verification URL in the user\'s default browser.'),
})

export type CortexLoginInput = z.infer<typeof cortexLoginInputSchema>

export interface CortexLoginOutput {
  ok: boolean
  message: string
  detail?: {
    verifyUrl?: string
    userCode?: string
    tenantSlug?: string
    userEmail?: string
    mcpName?: string
    configPath?: string
  }
}

export async function cortexLogin(input: CortexLoginInput): Promise<CortexLoginOutput> {
  // 1. Start the grant.
  const start = await startDeviceFlow(input.serverUrl)

  // 2. Surface the verification URL + code to the user. The MCP tool
  //    response will include these so the AI client can read them
  //    aloud / display them in the chat.
  if (input.openBrowser) {
    // Best-effort. Don't fail the flow if `open` errors (headless
    // environment, locked-down corp laptop, etc.) — the user can
    // copy/paste the URL.
    open(start.verifyUrl).catch(() => undefined)
  }

  // 3. Poll until approved / expired / denied.
  const result = await waitForApproval({
    serverUrl: input.serverUrl,
    deviceCode: start.deviceCode,
    intervalSec: start.interval,
    expiresInSec: start.expiresIn,
  })

  if (result.status !== 'approved') {
    switch (result.status) {
      case 'pending':
        return {
          ok: false,
          message:
            'Login still pending after local timeout. Run cortex_login again and approve the new code in your browser.',
          detail: { verifyUrl: start.verifyUrl, userCode: start.userCode },
        }
      case 'denied':
        return {
          ok: false,
          message: 'Login denied in browser. Run cortex_login again to retry.',
        }
      case 'expired':
        return {
          ok: false,
          message: `Device code expired before approval (${result.message}). Run cortex_login again.`,
        }
      case 'consumed':
        return {
          ok: false,
          message:
            'This device code was already consumed (likely a duplicate poll or replay). Run cortex_login fresh.',
        }
      case 'error':
        return { ok: false, message: `Login failed: ${result.message}` }
    }
  }

  // 4. Approved. Write the resulting MCP server entry into the
  //    Claude Code user config so a restart picks it up.
  await upsertMcpServer({
    name: input.mcpName,
    url: result.mcpUrl,
    bearer: result.bearer,
  })

  const who = result.userEmail ?? 'this user'
  const where = result.tenantSlug ? ` (tenant: ${result.tenantSlug})` : ''
  return {
    ok: true,
    message:
      `Connected to ${result.mcpUrl}${where} as ${who}. ` +
      `Restart Claude Code so the "${input.mcpName}" MCP becomes available.`,
    detail: {
      ...(result.tenantSlug ? { tenantSlug: result.tenantSlug } : {}),
      ...(result.userEmail ? { userEmail: result.userEmail } : {}),
      mcpName: input.mcpName,
      configPath: CLAUDE_CONFIG_PATH,
    },
  }
}
