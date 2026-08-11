import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { Cli, z } from 'incur'
import { douzeHome, ensureHome, type RegistryState } from '@douze/douzed'
import { REMOTE_MAX_SESSIONS, RemoteRelayMessage, findSurvivingSecrets, type RemoteDaemonMessage } from '@douze/shared'
import type { DaemonClient } from './daemon-client.js'
import { serveMcp, type McpHandle } from './mcp.js'
import { RelayClient } from './relay-client.js'
import { ToolSurfaceBuilder } from './surface.js'

/**
 * WO-014 — the daemon's half of the remote relay. One outbound WebSocket, no new listener, and
 * one isolated MCP server instance per platform session so two clients cannot see each other's
 * JSON-RPC ids or `initialize` state.
 *
 * The path is treated as less trusted than loopback throughout: the surface it serves is filtered
 * (`filterRemoteRegistry`), every `tools/call` is audited locally, and every result is run past
 * `findSurvivingSecrets` before it leaves this machine.
 */

export const RelayConfig = z.object({
  /** Relay base URL, no trailing slash — `https://relay.example`. */
  url: z.string(),
  /** Authenticates this daemon's WebSocket. Written by `douze connect`. */
  token: z.string(),
  /** Path half of the platform-facing MCP URL; the secret is in the path. */
  mcp_path: z.string(),
  /** T-014.3 — write tools are off the remote surface unless this is set. */
  allow_writes: z.boolean(),
  /** Whether a bearer token was sent at registration. The value itself is never stored. */
  bearer: z.boolean().optional(),
  /** T-014.4 — qualified tool names exempt from the outbound secret gate. */
  expose: z.array(z.string()).optional(),
})
export type RelayConfig = z.infer<typeof RelayConfig>

export interface AuditEntry {
  ts: string
  sid: string
  tool: string
}

export const relayConfigPath = (): string => join(douzeHome(), 'relay.json')
const auditPath = (): string => join(douzeHome(), 'remote-audit.jsonl')

/**
 * No relay configured is `null`; a relay.json that is there but not a pairing is an error. This
 * file decides which of your tools a hosted assistant can reach, so a shape nobody checked is not
 * something to shrug at and carry on with.
 */
export function readRelayConfig(): RelayConfig | null {
  const parsed = safeJson(readText(relayConfigPath()))
  if (parsed === undefined) return null
  const config = RelayConfig.safeParse(parsed)
  if (!config.success) {
    throw new Error(
      `${relayConfigPath()} is not a valid Douze relay pairing (${config.error.issues[0]?.message ?? 'bad shape'}` +
        ` at ${config.error.issues[0]?.path.join('.') || 'the root'}). Delete it and re-run \`douze connect <url>\`.`,
    )
  }
  return config.data
}

export function writeRelayConfig(config: RelayConfig): void {
  const path = join(ensureHome().home, 'relay.json')
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  // `mode` only applies when the file is created, and `--rotate` rewrites an existing one.
  chmodSync(path, 0o600)
}

/** T-014.3 — the last few remote calls, for `douze status`. */
export function readRemoteAudit(limit = 5): AuditEntry[] {
  const text = readText(auditPath())
  if (text === null) return []
  const lines = text.split('\n').filter(Boolean).slice(-limit)
  return lines.map((line) => safeJson(line)).filter((entry): entry is AuditEntry => entry !== undefined)
}

/**
 * T-014.3 — the remote surface, enforced here rather than in the relay or the platform: reads
 * always, writes only by opt-in, and destructive tools never. A caller-supplied `confirm: true`
 * is consent UX, not authentication, so no configuration can put a destructive tool back.
 */
export function filterRemoteRegistry(state: RegistryState, config: Pick<RelayConfig, 'allow_writes'>): RegistryState {
  return {
    ...state,
    tools: state.tools.filter(
      (t) => t.tool.side_effect === 'read' || (config.allow_writes && t.tool.side_effect === 'write'),
    ),
  }
}

/** Reconnect backoff: 1s doubling to 30s, forever — the daemon has nowhere else to be. */
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000

/** What one session may have queued for its MCP instance: the relay's own 8 × 1MB ceiling. */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024

interface Session {
  input: PassThrough
  /** In-flight `tools/call` ids and the tool each named, for the result gate and the audit. */
  calls: Map<string | number, string>
  handle: Promise<McpHandle>
}

export interface RemoteBridge {
  close: () => void
}

export function startRemoteBridge(daemon: DaemonClient, config: RelayConfig, version = '0.1.0'): RemoteBridge {
  const sessions = new Map<string, Session>()
  let socket: WebSocket | null = null
  let backoff = BACKOFF_MIN_MS
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const send = (message: RemoteDaemonMessage): void => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(message))
  }

  const closeSession = (sid: string): void => {
    const session = sessions.get(sid)
    if (!session) return
    sessions.delete(sid)
    session.input.end()
    void session.handle.then((handle) => handle.close()).catch(() => undefined)
  }

  const openSession = (sid: string): void => {
    // A repeat for a live sid would replace the map entry and orphan its MCP instance — unclosed,
    // still polling the daemon, and invisible to the cap below because sessions.size never moved.
    if (sessions.has(sid)) return
    // AC-014 — the cap is the daemon's, not the relay's; an excess session is refused, not queued.
    if (sessions.size >= REMOTE_MAX_SESSIONS) {
      send({ type: 'session.closed', sid })
      return
    }
    const input = new PassThrough()
    const output = new PassThrough()
    const calls = new Map<string | number, string>()

    // Its own Cli root and its own builder: the surface this instance serves is the filtered one,
    // and the local CLI/MCP surface must not see the filtering.
    const root = Cli.create('douze', { description: 'Douze', version, mcp: { name: 'douze', title: 'Douze' } })
    const builder = new ToolSurfaceBuilder(root, new RelayClient(daemon))
    const scoped = { registry: async () => filterRemoteRegistry(await daemon.registry(), config) }
    const handle = serveMcp({ builder, daemon: scoped, version, input, output })
    void handle.catch((error: unknown) => {
      warn(`remote session ${sid} failed to start — ${(error as Error).message}`)
      closeSession(sid)
    })
    sessions.set(sid, { input, calls, handle })

    // The MCP server writes newline-delimited JSON-RPC; each line is one frame for the relay.
    createInterface({ input: output }).on('line', (line) => {
      const message = safeJson(line)
      if (message === undefined) return
      send({ type: 'mcp.message', sid, message: gateResult(message, calls, config) })
    })
  }

  const handleFrame = (raw: string): void => {
    const parsed = RemoteRelayMessage.safeParse(safeJson(raw))
    if (!parsed.success) {
      warn('dropped a relay frame this daemon does not understand')
      return
    }
    const frame = parsed.data
    switch (frame.type) {
      case 'welcome':
        backoff = BACKOFF_MIN_MS
        return
      case 'ping':
        send({ type: 'pong' })
        return
      case 'session.open':
        openSession(frame.sid)
        return
      case 'session.close':
        closeSession(frame.sid)
        send({ type: 'session.closed', sid: frame.sid })
        return
      case 'mcp.message': {
        const session = sessions.get(frame.sid)
        if (!session) return
        // The MCP instance reads at its own pace. An honest relay caps itself at 8 in-flight 1MB
        // messages, so it never reaches this; a relay flooding the socket is refused rather than
        // buffered into this daemon's heap without limit.
        if (session.input.writableLength > MAX_QUEUED_BYTES) {
          warn(`remote session ${frame.sid} is not draining; closing it`)
          closeSession(frame.sid)
          send({ type: 'session.closed', sid: frame.sid })
          return
        }
        record(frame.sid, frame.message, session.calls)
        session.input.write(`${JSON.stringify(frame.message)}\n`)
        return
      }
    }
  }

  const connect = (): void => {
    if (stopped) return
    const ws = new WebSocket(websocketUrl(config.url))
    socket = ws
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token: config.token, daemon_version: version }))
    })
    ws.addEventListener('message', (event: MessageEvent) => handleFrame(String(event.data)))
    // Fail fast, like `extension_disconnected`: an in-flight call dies with the socket rather
    // than waiting for a reconnection whose platform session no longer exists.
    ws.addEventListener('close', () => {
      if (socket !== ws) return
      socket = null
      // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before closeSession() deletes from it
      for (const sid of [...sessions.keys()]) closeSession(sid)
      if (stopped) return
      retry = setTimeout(connect, backoff)
      retry.unref?.()
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    })
    // A failed connect emits `error` then `close`; the reconnect is scheduled there.
    ws.addEventListener('error', () => undefined)
  }

  connect()

  return {
    close: () => {
      stopped = true
      if (retry) clearTimeout(retry)
      // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before closeSession() deletes from it
      for (const sid of [...sessions.keys()]) closeSession(sid)
      socket?.close()
      socket = null
    },
  }
}

/** The daemon dials `wss://…/ws`; `http(s)` in the config is the same host over the same TLS. */
export const websocketUrl = (url: string): string => `${url.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`

/**
 * T-014.3 — a routing-level peek, not a parse of the call: the tool name for the audit line and
 * the request id the result gate keys on. Anything else in the frame stays opaque to the bridge.
 */
function record(sid: string, message: unknown, calls: Map<string | number, string>): void {
  const rpc = message as { id?: string | number; method?: string; params?: { name?: string } }
  if (rpc?.method !== 'tools/call') return
  const tool = rpc.params?.name ?? 'unknown'
  if (rpc.id !== undefined) calls.set(rpc.id, tool)
  try {
    ensureHome()
    appendFileSync(auditPath(), `${JSON.stringify({ ts: new Date().toISOString(), sid, tool })}\n`)
  } catch (error) {
    // An unwritable audit file is worth a line on stderr, never a dead daemon.
    warn(`could not append to the remote audit log — ${(error as Error).message}`)
  }
}

/**
 * T-014.4 — the last gate before a result leaves this machine. Redaction already ran on the way
 * into a fixture, but a live dashboard response is not a fixture: it is whatever the target
 * returned just now, and the platform stores it. A credential-shaped value in it is refused by
 * default and released only by naming the tool in `expose`.
 */
export function gateResult(
  message: unknown,
  calls: Map<string | number, string>,
  config: Pick<RelayConfig, 'expose'>,
): unknown {
  const rpc = message as { id?: string | number; result?: unknown }
  if (rpc?.id === undefined) return message
  const tool = calls.get(rpc.id)
  if (tool === undefined) return message
  calls.delete(rpc.id)
  if (rpc.result === undefined || config.expose?.includes(tool)) return message

  const findings = findSurvivingSecrets(rpc.result)
  if (findings.length === 0) return message
  return {
    jsonrpc: '2.0',
    id: rpc.id,
    error: {
      code: -32603,
      message:
        `Douze withheld this result: ${tool} returned credential-shaped values at ${findings.join(', ')}. ` +
        `Add "${tool}" to "expose" in ${relayConfigPath()} to send this tool's results anyway.`,
    },
  }
}

const warn = (message: string): void => {
  process.stderr.write(`douze: ${message}\n`)
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const safeJson = (text: string | null): unknown => {
  if (text === null) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
