import { z } from 'zod'
import type { RelayErrorCode } from '@douze/shared'
import { ExtensionFrame, annotationsFor } from './protocol.js'
import type { AttachedTool, HostFrame, ToolFailure, Trust } from './protocol.js'

/**
 * WO-015 T-015.6 — **the one MCP server implementation**, shared by the cloud relay and the local
 * stdio bridge. It terminates MCP for a connected client and turns `tools/call` into a `tool.call`
 * frame for the attached extension, which is the thing that actually holds recipes and executes.
 *
 * Transport-pure by construction: messages in (`handle`, `receive`), messages out (the `send` and
 * `notify` callbacks). No HTTP, no WebSocket, no stdio, and no `node:*` import anywhere in this
 * package, so a browser bundle can hold it later if a pipe ever needs to.
 *
 * It owns MCP sessions **entirely**, because the extension cannot: an MV3 service worker Chrome
 * evicts loses any in-flight promise, and an inbound frame does not wake a dead worker. So
 * `initialize` and `tools/list` are answered from the cached surface, which is what makes a
 * connector added while Chrome is closed list its tools instead of looking broken. Only
 * `tools/call` needs the browser awake.
 *
 * Hand-rolled rather than built on `@modelcontextprotocol/server`: the surface is four methods
 * and two notifications, the SDK is on an alpha that has already renamed a property under this
 * repo once, and its lazy capability installation is the exact trap e634feb had to work around
 * with a register-then-remove placeholder tool. Declaring the capability honestly is one line
 * here (see `initialize`), and a dependency this package does not need is one it does not carry.
 */

/** The version this host speaks; a client asking for an older one we know gets that one back. */
const PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05'])

/** Matches the relay's per-call ceiling: a call reaching a live dashboard can legitimately be slow. */
const CALL_TIMEOUT_MS = 120_000

export type JsonRpcId = string | number

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  /** null only where JSON-RPC requires it: a message so malformed it carried no usable id. */
  id: JsonRpcId | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface McpHostOptions {
  /**
   * Stamped on every `tool.call` this host emits. Whoever constructs the host knows what it is —
   * the relay is `remote`, a paired loopback bridge is `local` — and no client can influence it.
   */
  trust: Trust
  /** Delivers one frame to the attached extension. May throw if the socket died under it. */
  send: (frame: HostFrame) => void
  /** Delivers server-initiated JSON-RPC (today: `notifications/tools/list_changed`) to the client. */
  notify?: (notification: JsonRpcNotification) => void
  serverInfo?: { name: string; title?: string; version: string }
  instructions?: string
  callTimeoutMs?: number
}

const DEFAULT_SERVER_INFO = { name: 'douze', title: 'Douze', version: '0.1.0' }

const DEFAULT_INSTRUCTIONS =
  'Tools recorded from your own authenticated dashboards. Each tool is named <recipe>_<tool> and ' +
  'executes inside your signed-in browser. Tool names and descriptions change while this server ' +
  'runs; re-read tools/list after a notifications/tools/list_changed.'

/**
 * REQ-CON-004 — the extension is the thing that is offline, and a chat user with no terminal has
 * to be able to act on this sentence alone.
 */
const DISCONNECTED =
  'The Douze browser extension is not connected right now, so there is nothing to run this tool. ' +
  'Open the browser where Douze is installed and check that the extension is enabled and connected, ' +
  'then try again — it holds your recipes and runs every call inside your signed-in tabs.'

/**
 * The extension went away with a call already sent to it. That call is never re-sent: a tool can
 * be a write, and a silent retry of a write is worse than a failure a human decides about.
 */
const DROPPED =
  'The Douze browser extension disconnected while this tool was running. Douze never retries a ' +
  'call automatically, because a tool can write — check whether it took effect, then call it again ' +
  'if it did not.'

const TIMED_OUT =
  'The Douze browser extension did not answer this call in time. It may still be running, or the ' +
  'browser may be asleep — check the result before calling again.'

/** Only the shape needed to route; everything past this is per-method. */
const JsonRpcMessage = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).nullish(),
})

type Outcome = { result: unknown } | { failure: ToolFailure }

export class McpHost {
  readonly trust: Trust
  private readonly options: McpHostOptions
  private readonly callTimeoutMs: number
  private surface: AttachedTool[] = []
  private attachedState = false
  /**
   * Keyed by the id this host minted, which is a string by construction — so a `tool.result`
   * carrying `1` can never settle the call waiting on `"1"`. Ids keeping their JSON type is a
   * lesson the relay learned the hard way (see waiterKey in packages/relay/src/server.ts); a host
   * that mints its own has the same property for free, and the MCP request id is never a key here
   * at all because `handle()` awaits each request and echoes its id straight back.
   */
  private readonly pending = new Map<string, { resolve: (outcome: Outcome) => void; timer: ReturnType<typeof setTimeout> }>()
  /** Unique per host instance, so ids from two sessions on one attachment cannot collide. */
  private readonly prefix = Math.random().toString(36).slice(2, 10)
  private calls = 0

  constructor(options: McpHostOptions) {
    this.options = options
    this.trust = options.trust
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS
  }

  get attached(): boolean {
    return this.attachedState
  }

  /** The cached surface, which is what `tools/list` answers from whether or not anyone is attached. */
  get tools(): readonly AttachedTool[] {
    return this.surface
  }

  /**
   * The transport owns the socket, so it owns this: true once the extension has said `hello`,
   * false the moment the socket is gone. Going false fails everything in flight rather than
   * leaving it to time out on a failure already known.
   */
  setAttached(attached: boolean): void {
    if (attached === this.attachedState) return
    this.attachedState = attached
    if (!attached) this.failPending({ code: 'extension_disconnected', message: DROPPED, retryable: true })
  }

  /**
   * Replaces the cached surface. Called by `receive` on a `surface.push`, and directly by a
   * transport that caches one surface per attachment and seeds each new session from it.
   */
  pushSurface(tools: AttachedTool[]): void {
    // The extension pushes on every connect, so an unchanged surface is the common case and must
    // not churn a listChanged at every reconnect.
    if (JSON.stringify(tools) === JSON.stringify(this.surface)) return
    this.surface = tools
    this.options.notify?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }

  /**
   * One frame from the extension. `hello` and `pong` belong to the transport's handshake and
   * heartbeat and are ignored here; anything that does not parse is dropped, because a host that
   * threw on a malformed frame would hand the transport's socket handler an exception per frame.
   */
  receive(frame: unknown): void {
    const parsed = ExtensionFrame.safeParse(frame)
    if (!parsed.success) return
    if (parsed.data.type === 'surface.push') {
      this.pushSurface(parsed.data.tools)
      return
    }
    if (parsed.data.type !== 'tool.result') return
    const waiter = this.pending.get(parsed.data.id)
    if (!waiter) return
    this.pending.delete(parsed.data.id)
    clearTimeout(waiter.timer)
    const { result, error } = parsed.data
    waiter.resolve(error ? { failure: error } : { result: result ?? { content: [] } })
  }

  /** One JSON-RPC message from the MCP client. Returns null for a notification, which owes no answer. */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    const parsed = JsonRpcMessage.safeParse(message)
    if (!parsed.success) return error(null, -32_600, 'Not a JSON-RPC 2.0 message with a method.')
    const { id, method } = parsed.data
    const params = parsed.data.params ?? {}
    if (id === null || id === undefined) return null

    switch (method) {
      case 'initialize':
        return this.initialize(id, params)
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: this.listTools() } }
      case 'tools/call':
        return this.callTool(id, params)
      default:
        return error(id, -32_601, `Method "${method}" is not supported by Douze.`)
    }
  }

  /** Fails everything in flight and stops every timer. The transport calls this with the session. */
  close(): void {
    this.attachedState = false
    this.failPending({ code: 'extension_disconnected', message: DROPPED, retryable: true })
  }

  private initialize(id: JsonRpcId, params: Record<string, unknown>): JsonRpcResponse {
    const asked = params['protocolVersion']
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion:
          typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
        // Declared unconditionally, empty surface or not. The MCP SDK installs its tools handlers
        // lazily on the first registerTool, so a session that initialized against an empty surface
        // answered tools/list with "Method not found" for its whole life (fixed in e634feb by
        // registering and removing a placeholder). A hosted client attached before the first site
        // is recorded is exactly that case, and it is the normal one here.
        capabilities: { tools: { listChanged: true } },
        serverInfo: this.options.serverInfo ?? DEFAULT_SERVER_INFO,
        instructions: this.options.instructions ?? DEFAULT_INSTRUCTIONS,
      },
    }
  }

  private listTools(): Record<string, unknown>[] {
    return this.surface.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
      annotations: annotationsFor(tool.side_effect),
    }))
  }

  private async callTool(id: JsonRpcId, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const name = typeof params['name'] === 'string' ? params['name'] : ''
    // Before the tool lookup: with nothing attached the cached surface is the last thing anyone
    // pushed, and "the extension is offline" is the honest answer either way.
    if (!this.attachedState) return refusal(id, 'extension_disconnected', DISCONNECTED, true)
    if (!this.surface.some((tool) => tool.name === name)) {
      return error(id, -32_602, `Unknown tool "${name}". Read tools/list for the current surface.`)
    }
    const args = params['arguments']
    const callId = `${this.prefix}-${++this.calls}`

    const outcome = await new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        resolve({ failure: { code: 'timeout', message: TIMED_OUT, retryable: true } })
      }, this.callTimeoutMs)
      // A pending call must never hold a Node process open on its own.
      ;(timer as { unref?: () => void }).unref?.()
      this.pending.set(callId, { resolve, timer })
      try {
        // `trust` comes from construction and `args` is the client's own input, so nothing a
        // client sends can raise its own trust level — the two never meet.
        this.options.send({
          type: 'tool.call',
          id: callId,
          name,
          args: isRecord(args) ? args : {},
          trust: this.trust,
        })
      } catch {
        this.pending.delete(callId)
        clearTimeout(timer)
        resolve({ failure: { code: 'extension_disconnected', message: DISCONNECTED, retryable: true } })
      }
    })

    if ('result' in outcome) return { jsonrpc: '2.0', id, result: outcome.result }
    return refusal(id, outcome.failure.code, outcome.failure.message, outcome.failure.retryable)
  }

  private failPending(failure: ToolFailure): void {
    for (const [callId, waiter] of this.pending) {
      this.pending.delete(callId)
      clearTimeout(waiter.timer)
      waiter.resolve({ failure })
    }
  }
}

/**
 * A named refusal, in the one shape a transport can render: hosted MCP clients drop an HTTP error
 * body on the floor but do show a JSON-RPC error, and `data.error` carries the name so the relay
 * and the bridge can act on it without matching on prose.
 */
const refusal = (
  id: JsonRpcId,
  code: RelayErrorCode | string,
  message: string,
  retryable: boolean,
): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code: -32_000, message, data: { error: code, retryable } },
})

const error = (id: JsonRpcId | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
