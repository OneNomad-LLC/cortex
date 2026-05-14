/**
 * RFC 8628 device authorization flow client. Talks to pyre-web's
 * /api/cortex/device/* endpoints. Pure transport — no MCP, no config
 * writes; the tool handlers compose those.
 */

export interface DeviceStartResponse {
  deviceCode: string
  userCode: string
  /** Where the user lands in their browser to confirm. */
  verifyUrl: string
  /** Seconds between polls. */
  interval: number
  /** Seconds until the grant expires. */
  expiresIn: number
}

export interface DevicePollSuccess {
  status: 'approved'
  mcpUrl: string
  bearer: string
  tenantSlug?: string
  userEmail?: string
}

export interface DevicePollPending {
  status: 'pending'
}

export interface DevicePollFailure {
  status: 'expired' | 'denied' | 'consumed' | 'error'
  message: string
}

export type DevicePollResult = DevicePollSuccess | DevicePollPending | DevicePollFailure

export class DeviceFlowError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'DeviceFlowError'
  }
}

function joinUrl(serverUrl: string, path: string): string {
  return serverUrl.replace(/\/+$/, '') + path
}

export async function startDeviceFlow(serverUrl: string): Promise<DeviceStartResponse> {
  const res = await fetch(joinUrl(serverUrl, '/api/cortex/device/start'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new DeviceFlowError(
      `Device start failed (${res.status}): ${text || res.statusText}`,
      res.status,
    )
  }
  return (await res.json()) as DeviceStartResponse
}

export async function pollOnce(serverUrl: string, deviceCode: string): Promise<DevicePollResult> {
  const res = await fetch(joinUrl(serverUrl, '/api/cortex/device/poll'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode }),
  })

  if (res.status === 410) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    const msg = body.error ?? ''
    if (msg.includes('expired')) return { status: 'expired', message: msg }
    return { status: 'consumed', message: msg }
  }
  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return { status: 'denied', message: body.error ?? 'denied' }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { status: 'error', message: `poll failed (${res.status}): ${text || res.statusText}` }
  }

  const body = (await res.json()) as {
    pending?: boolean
    mcpUrl?: string
    bearer?: string
    tenantSlug?: string
    userEmail?: string
  }
  if (body.pending) return { status: 'pending' }
  if (body.mcpUrl && body.bearer) {
    return {
      status: 'approved',
      mcpUrl: body.mcpUrl,
      bearer: body.bearer,
      ...(body.tenantSlug ? { tenantSlug: body.tenantSlug } : {}),
      ...(body.userEmail ? { userEmail: body.userEmail } : {}),
    }
  }
  return { status: 'error', message: 'unexpected poll response shape' }
}

export interface WaitForApprovalInput {
  serverUrl: string
  deviceCode: string
  intervalSec: number
  expiresInSec: number
  /** Optional callback fired before each poll attempt. Useful for the
   *  MCP tool's progress reporting back to the AI client. */
  onTick?: (elapsedSec: number) => void
}

/**
 * Polls until the grant transitions to a terminal state (approved /
 * denied / expired / error) or the local timeout is reached. Returns
 * the final result; never throws on poll-loop conditions, only on
 * truly unrecoverable transport errors.
 */
export async function waitForApproval(input: WaitForApprovalInput): Promise<DevicePollResult> {
  const start = Date.now()
  const deadlineMs = start + input.expiresInSec * 1000
  const intervalMs = Math.max(1000, input.intervalSec * 1000)

  while (Date.now() < deadlineMs) {
    const elapsedSec = Math.floor((Date.now() - start) / 1000)
    input.onTick?.(elapsedSec)
    const result = await pollOnce(input.serverUrl, input.deviceCode)
    if (result.status !== 'pending') return result
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { status: 'expired', message: 'local timeout reached before user approved' }
}
