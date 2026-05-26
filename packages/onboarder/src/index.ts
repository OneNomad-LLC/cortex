#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { cortexLogin, cortexLoginInputSchema } from './tools/login.js'
import { cortexLogout, cortexLogoutInputSchema } from './tools/logout.js'
import { cortexStatus, cortexStatusInputSchema } from './tools/status.js'

/**
 * @onenomad/przm-cortex-onboarder
 *
 * Stdio MCP server that handles Cortex login + writes the per-tenant
 * Cortex MCP entry into Claude Code's user config. Install once with
 *
 *   claude mcp add cortex-onboarder -- npx -y @onenomad/przm-cortex-onboarder
 *
 * After that the user just says "cortex login" in chat and the
 * cortex_login tool runs the device-code flow end-to-end.
 *
 * No secrets in the install command, no manual config editing, no
 * bearer tokens in shell history.
 */

const server = new Server(
  { name: 'cortex-onboarder', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

// --- Tool registry -------------------------------------------------

interface RegisteredTool {
  name: string
  description: string
  schema: z.ZodTypeAny
  // After parse() the input is validated; the handler casts internally.
  // This keeps the tools array a single concrete type so TS does not
  // intersect every schema's input shape into one impossible parameter.
  handler: (input: unknown) => Promise<unknown>
}

const tools: RegisteredTool[] = [
  {
    name: 'cortex_login',
    description:
      'Run the Cortex device-code login flow. Opens the verification URL in the user\'s browser, waits for them to approve, then writes the resulting Cortex MCP server into Claude Code config under the given name (default "cortex"). The user must restart Claude Code afterward to pick up the new MCP. Use this whenever a user asks to "log in to Cortex", "connect Cortex", or first-run set up.',
    schema: cortexLoginInputSchema,
    handler: (input) => cortexLogin(input as Parameters<typeof cortexLogin>[0]),
  },
  {
    name: 'cortex_logout',
    description:
      'Remove a Cortex MCP entry from Claude Code config. Useful when switching tenants or revoking access on a shared machine. The user must restart Claude Code to fully drop the connection.',
    schema: cortexLogoutInputSchema,
    handler: (input) => cortexLogout(input as Parameters<typeof cortexLogout>[0]),
  },
  {
    name: 'cortex_status',
    description:
      'Check whether a Cortex MCP entry exists in Claude Code config and (optionally) probe its URL with the saved bearer to confirm it still works.',
    schema: cortexStatusInputSchema,
    handler: (input) => cortexStatus(input as Parameters<typeof cortexStatus>[0]),
  },
]

// --- MCP wiring ----------------------------------------------------

function jsonSchemaFromZod(schema: z.ZodTypeAny): Record<string, unknown> {
  // Minimal JSON Schema synthesis. We only use object schemas with
  // string / boolean / url leaves, so a hand-rolled walker is enough
  // and avoids pulling in zod-to-json-schema. Keeps the package small.
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, child] of Object.entries(shape)) {
      properties[key] = leafToJsonSchema(child)
      if (!child.isOptional() && !(child instanceof z.ZodDefault)) {
        required.push(key)
      }
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    }
  }
  return leafToJsonSchema(schema)
}

function leafToJsonSchema(s: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap ZodDefault / ZodOptional — keep the description from the
  // outer wrapper if present, plus the inner schema's type.
  let inner = s
  let description = (s.description as string | undefined) ?? undefined
  let defaultValue: unknown
  let hasDefault = false
  if (inner instanceof z.ZodDefault) {
    defaultValue = inner._def.defaultValue()
    hasDefault = true
    inner = inner._def.innerType as z.ZodTypeAny
    if (!description) description = inner.description ?? undefined
  }
  if (inner instanceof z.ZodOptional) {
    inner = inner._def.innerType as z.ZodTypeAny
    if (!description) description = inner.description ?? undefined
  }

  const out: Record<string, unknown> = {}
  if (inner instanceof z.ZodString) out.type = 'string'
  else if (inner instanceof z.ZodBoolean) out.type = 'boolean'
  else if (inner instanceof z.ZodNumber) out.type = 'number'
  else out.type = 'string'

  if (description) out.description = description
  if (hasDefault) out.default = defaultValue
  return out
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: jsonSchemaFromZod(t.schema),
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = tools.find((x) => x.name === req.params.name)
  if (!t) {
    throw new Error(`Unknown tool: ${req.params.name}`)
  }
  const parsed = t.schema.parse(req.params.arguments ?? {})
  const result = await t.handler(parsed)
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(result, null, 2) },
    ],
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
