import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Logger } from "@cortex/core";

/**
 * Spawn a stdio MCP server bin as a subprocess and connect a Client to it.
 * Used for both Engram and Persona — they're CLI-installable MCP servers,
 * not libraries.
 *
 * `command` is resolved against PATH by the OS. On Windows, global npm bins
 * are installed as `.cmd` wrappers; Node's spawn handles them when PATH
 * includes the npm global bin dir, which it does after `npm install -g`.
 */
export interface McpSubprocessOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Friendly id for logs. */
  id: string;
  logger: Logger;
}

export interface McpSubprocess {
  client: Client;
  close(): Promise<void>;
}

export async function connectMcpSubprocess(
  opts: McpSubprocessOptions,
): Promise<McpSubprocess> {
  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args ?? [],
    env: {
      ...sanitizeEnv(process.env),
      ...(opts.env ?? {}),
    },
  });

  const client = new Client(
    { name: "cortex", version: "0.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  opts.logger.info("mcp.subprocess.connected", { id: opts.id });

  return {
    client,
    async close() {
      try {
        await client.close();
      } catch (err) {
        opts.logger.warn("mcp.subprocess.close_failed", {
          id: opts.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * Strip undefined values from process.env so it matches
 * `Record<string, string>` that StdioClientTransport wants.
 */
function sanitizeEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Call a tool on a subprocess MCP server and parse its JSON text response.
 * Every tool we use returns `content: [{ type: "text", text: "<json>" }]` —
 * this helper extracts + parses that.
 */
export async function callJsonTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };

  if (result.isError) {
    const msg = result.content
      ?.map((c) => c.text ?? "")
      .filter(Boolean)
      .join("\n");
    throw new Error(`MCP tool '${name}' returned isError: ${msg ?? "(no message)"}`);
  }

  const text =
    result.content?.find((c) => c.type === "text")?.text ?? "";
  if (!text) {
    // Some tools return empty content on success.
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // If it's not JSON, return it as a string — caller decides what to do.
    return text as unknown as T;
  }
}
