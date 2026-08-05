import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { Mcp, z } from 'incur'
import type { Readable, Writable } from 'node:stream'
import type { DaemonClient } from './daemon-client.js'
import { PROGRESS_INTERVAL_MS } from './relay-client.js'
import type { ToolSurfaceBuilder } from './surface.js'

/**
 * How often the registry is polled for a new revision. The watcher settles in 250 ms, so a
 * 2-second poll keeps a disk edit inside the 5 seconds AC-RUN-002.1 allows end to end.
 *
 * ponytail: polling, not a subscription. One idle GET every 2s on loopback against a daemon
 * that already holds the state in memory. Swap for an SSE endpoint on recond if the poll ever
 * shows up in a profile.
 */
const POLL_MS = Number(process.env['RECON_REGISTRY_POLL_MS'] ?? 2000)

export interface McpOptions {
  builder: ToolSurfaceBuilder
  daemon: DaemonClient
  name?: string
  version?: string
  input?: Readable
  output?: Writable
  pollMs?: number
}

export interface McpHandle {
  server: McpServer
  /** Pulls the registry once and re-syncs. Exposed so tests need not wait on the poll. */
  refresh: () => Promise<boolean>
  close: () => Promise<void>
}

/**
 * `recon --mcp`.
 *
 * incur's own `Mcp.serve` materialises the tool list once at connect time and never exposes the
 * `McpServer`, so a recipe approved after launch would be invisible until restart — the exact
 * thing ADR-005 exists to avoid. This is the wrapper that decision anticipated: incur still owns
 * the command tree (`Cli.toCommands`), the tool projection (`Mcp.collectTools`) and the execution
 * pipeline (`Mcp.callTool`); only registration is ours, because only registration needs to change
 * while a client is connected.
 *
 * Discovery is `direct`: every tool is a literal entry in `tools/list` under its
 * `<recipe>_<tool>` name (AC-RUN-001.2). incur's default is `progressive` — four static tools
 * plus a searchable catalog — which would also survive a surface change without any
 * notification, but it hides the real names from `tools/list` and routes every call through a
 * read/write gate. Recon's surface is narrow enough that the literal list is worth more than the
 * token saving, and `notifications/tools/list_changed` covers the churn (AC-RUN-002.2).
 */
export async function serveMcp(options: McpOptions): Promise<McpHandle> {
  const { builder, daemon } = options
  const name = options.name ?? 'recon'
  const version = options.version ?? '0.1.0'

  const server = new McpServer(
    { name, title: 'Recon', version },
    {
      instructions:
        'Tools recorded from your own authenticated dashboards. Each tool is named <recipe>_<tool> and executes inside your signed-in browser. Tool names and descriptions change while this server runs; re-read tools/list after a notifications/tools/list_changed.',
    },
  )

  const registered = new Map<string, { handle: RegisteredTool; fingerprint: string }>()

  const sync = (): void => {
    const tools = Mcp.collectTools(builder.commands as Map<string, unknown>, [])
    const present = new Set<string>()

    for (const tool of tools) {
      present.add(tool.name)
      const fingerprint = JSON.stringify([tool.description, tool.inputSchema, tool.annotations])
      const existing = registered.get(tool.name)
      if (existing?.fingerprint === fingerprint) continue

      const config = toolConfig(tool)
      if (existing) {
        // The SDK emits notifications/tools/list_changed on update as well as on register.
        existing.handle.update(config)
        existing.fingerprint = fingerprint
        continue
      }
      const handle = server.registerTool(tool.name, config, (...callArgs: unknown[]) => {
        const hasInput = Object.keys(tool.inputSchema.properties ?? {}).length > 0
        const params = (hasInput ? callArgs[0] : {}) as Record<string, unknown>
        const extra = (hasInput ? callArgs[1] : callArgs[0]) as CallExtra
        return call(tool.name, params, extra)
      }) as RegisteredTool
      registered.set(tool.name, { handle, fingerprint })
    }

    for (const [toolName, entry] of registered) {
      if (present.has(toolName)) continue
      entry.handle.remove()
      registered.delete(toolName)
    }
  }

  /**
   * Resolved fresh on every call rather than closed over: after a hot reload the command behind
   * a name may carry a new schema, and a stale closure would validate against the old one.
   */
  const call = async (toolName: string, params: Record<string, unknown>, extra: CallExtra) => {
    const tool = Mcp.collectTools(builder.commands as Map<string, unknown>, []).find((t) => t.name === toolName)
    if (!tool) {
      return { content: [{ type: 'text' as const, text: `Tool "${toolName}" no longer exists.` }], isError: true }
    }
    const stop = startProgress(toolName, extra)
    try {
      return await Mcp.callTool(tool, params, { name, version, extra })
    } finally {
      stop()
    }
  }

  const refresh = async (): Promise<boolean> => {
    const state = await daemon.registry()
    const result = builder.apply(state)
    if (result.changed) sync()
    return result.changed
  }

  await refresh()

  // AC-RUN-002.4 — a client that ignores listChanged still gets the current surface here, at
  // startup, because the surface is rebuilt from the registry rather than cached from install.
  const poll = setInterval(() => {
    void refresh().catch(() => undefined)
  }, options.pollMs ?? POLL_MS)
  poll.unref?.()

  const transport = new StdioServerTransport(options.input as never, options.output as never)
  await server.connect(transport)

  return {
    server,
    refresh,
    close: async () => {
      clearInterval(poll)
      await server.close()
    },
  }
}

/**
 * AC-CON-003.1 — a relayed call waits on a human's browser, so silence past a minute reads as a
 * hang. A tick every 60 seconds keeps the client's own timer alive until the call resolves.
 */
function startProgress(toolName: string, extra: CallExtra): () => void {
  const token = extra?.mcpReq?._meta?.progressToken ?? extra?._meta?.progressToken
  const send = extra?.sendNotification
  if (token === undefined || !send) return () => undefined

  const started = Date.now()
  let progress = 0
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000)
    void send({
      method: 'notifications/progress',
      params: {
        progressToken: token,
        progress: ++progress,
        message: `${toolName} is still running in your browser (${elapsed}s elapsed).`,
      },
    })
  }, PROGRESS_INTERVAL_MS)

  return () => clearInterval(timer)
}

function toolConfig(tool: Mcp.ToolEntry): Record<string, unknown> {
  // incur flattens `args` and `options` into one MCP input schema and parses with parseMode
  // 'flat'; mirroring that here is what keeps the MCP JSON Schema identical to the Zod schema
  // the CLI validates against (AC-RUN-004.1 / COV_RUN_004.1).
  const shape: Record<string, z.ZodType> = {
    ...(tool.command as { args?: { shape: Record<string, z.ZodType> } }).args?.shape,
    ...(tool.command as { options?: { shape: Record<string, z.ZodType> } }).options?.shape,
  }
  return {
    ...(tool.description ? { description: tool.description } : {}),
    ...(Object.keys(shape).length > 0 ? { inputSchema: z.object(shape) } : {}),
    ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema) } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }
}

interface RegisteredTool {
  update: (config: Record<string, unknown>) => void
  remove: () => void
}

interface CallExtra {
  _meta?: { progressToken?: string | number }
  mcpReq?: { _meta?: { progressToken?: string | number } }
  sendNotification?: (notification: {
    method: 'notifications/progress'
    params: { progressToken: string | number; progress: number; message: string }
  }) => Promise<void>
}
