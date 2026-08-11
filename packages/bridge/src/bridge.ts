import { createServer, type Server as HttpServer } from 'node:http'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { HEARTBEAT_MS } from '@douze/shared'
import { ExtensionFrame, McpHost, welcome, type JsonRpcResponse } from '@douze/mcp-host'
import {
  ATTEMPTS,
  codeMatches,
  credentialFile,
  mintCode,
  mintSecret,
  readCredential,
  secretMatches,
  writeCredential,
} from './pairing.js'

/**
 * WO-015 T-015.11 — **the local pipe**. The relay (WO-015 T-015.7) lets hosted assistants reach
 * the extension over the cloud; this lets an MCP client running on the user's own machine — Claude
 * Code, Cursor, VS Code, Claude Desktop — reach the same extension with nothing in between.
 *
 * Two ends, one `McpHost`:
 *
 * - **stdio**, newline-delimited JSON-RPC on stdin/stdout, which is what every local MCP client
 *   speaks. stdout carries protocol and nothing else; a stray byte there is a corrupted session,
 *   so every diagnostic in this file goes to stderr (see `diag`).
 * - **a loopback WebSocket server** the extension dials into. An extension cannot listen, and it
 *   already knows how to dial — so the direction is the same one it uses for the relay, and the
 *   frames on it are the same attachment protocol.
 *
 * It is a transport and nothing else. No recipes, no storage, no inference, no policy: those live
 * in the extension, and the whole point of two pipes over one brain is that neither pipe grows a
 * second copy. The only thing this process persists is the pairing credential, which is about who
 * may attach and not about what Douze knows.
 *
 * The one thing it does claim is trust: the host is constructed `local`, so every `tool.call` it
 * emits is stamped `local` and the extension's guards let a destructive tool through with
 * `confirm: true`. That claim is exactly what pairing.ts exists to earn.
 */

/**
 * Five ports, walked in order, deliberately **not** `PORT_RANGE` (8787–8791) from
 * `@douze/shared`.
 *
 * Two reasons. That range belongs to douzed, which speaks an entirely different protocol on it
 * (`ClientMessage`/`ServerMessage` — capture, not attachment); until the daemon is deleted in
 * phase 4 an extension probing one range would keep meeting the wrong server on it. And a bridge
 * is per MCP client, not per machine: Claude Code and Cursor open one each, so several are live at
 * once and the walk is load-bearing rather than a courtesy to squatters.
 *
 * The convention itself is reused as-is, because the extension's only way to find a listener is to
 * probe: five is enough for every client a person has open and short enough to sweep on a timer.
 */
export const BRIDGE_PORT_RANGE = [8912, 8913, 8914, 8915, 8916] as const

/** Frames are small; ws defaults to 100 MB, which nothing here needs. */
const MAX_PAYLOAD = 1_048_576
const HELLO_TIMEOUT_MS = 5_000

/**
 * How long a `tools/call` waits for a detached extension before it is answered as offline — the
 * relay's number and the relay's reason (packages/relay/src/server.ts:60). The far side is the
 * same evictable MV3 service worker, nothing outside can wake it, and the only thing that revives
 * it on its own is `chrome.alarms` with its 30-second floor. A shorter grace reports a browser
 * that is merely asleep as one that is gone.
 *
 * It matters *more* here than on the relay: a bridge is spawned by the MCP client, so a cold start
 * routinely races a browser that has not dialled in yet. `initialize` and `tools/list` never wait
 * — they are answered from the cached surface, and a surface arriving later becomes a
 * `notifications/tools/list_changed` on stdout, which a stdio client acts on immediately.
 */
const WAKE_GRACE_MS = 40_000

export interface BridgeOptions {
  /**
   * The MCP client's stdin/stdout, passed in rather than reached for: the real output stream is
   * named exactly once in this package, in bin.ts, and a test holds that line. Everything else
   * that has something to say has `diag`, which is stderr.
   */
  input: Readable
  output: Writable
  ports?: readonly number[]
  heartbeatMs?: number
  wakeGraceMs?: number
  helloTimeoutMs?: number
}

export interface Bridge {
  port: number
  /** The code a human must type into the extension, or null when this install is already paired. */
  code: string | null
  close: () => Promise<void>
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const { input, output } = options
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const graceMs = options.wakeGraceMs ?? WAKE_GRACE_MS
  const helloMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS

  let credential = readCredential()
  const code = credential ? null : mintCode()
  let failures = 0
  let socket: WebSocket | null = null
  let heartbeat: NodeJS.Timeout | undefined
  let lastPong = 0
  const waking = new Set<{ resolve: () => void; timer: NodeJS.Timeout }>()

  const live = (): boolean => socket?.readyState === 1

  const host = new McpHost({
    trust: 'local',
    send: (frame) => {
      // Thrown rather than dropped: the host turns it into this call's offline refusal, where
      // swallowing it would leave the client waiting out the full 120s timeout.
      if (!live()) throw new Error('detached')
      socket?.send(JSON.stringify(frame))
    },
    // stdio is bidirectional, so unlike the relay this pipe really can tell a client the surface
    // changed. That is what makes a bridge started before Chrome useful: it lists nothing at
    // first, then says so the moment the extension attaches and pushes.
    notify: (notification) => write(notification),
  })

  const write = (message: unknown): void => {
    // The one place anything reaches stdout, and it only ever emits JSON-RPC.
    output.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * Parks a call until the extension attaches or the grace runs out. Nothing is re-sent here —
   * the call has not been sent yet. A call already in flight when the socket dropped is failed by
   * `setAttached(false)` and stays failed, because a tool can be a write.
   */
  const waitForAttach = (): Promise<void> =>
    new Promise<void>((resolve) => {
      diag(`waiting up to ${Math.round(graceMs / 1000)}s for the extension to attach`)
      const waiter = { resolve, timer: setTimeout(() => release(waiter), graceMs) }
      waiter.timer.unref()
      waking.add(waiter)
    })

  const release = (waiter: { resolve: () => void; timer: NodeJS.Timeout }): void => {
    clearTimeout(waiter.timer)
    waking.delete(waiter)
    waiter.resolve()
  }

  const dispatch = async (message: Record<string, unknown>): Promise<void> => {
    // Only a call needs the browser awake; making `initialize` or `tools/list` wait would stall a
    // client that is merely finding out what exists.
    if (message['method'] === 'tools/call' && !live()) await waitForAttach()
    const reply = await host.handle(message)
    if (reply) write(reply)
  }

  const onLine = (raw: string): void => {
    if (raw.trim() === '') return
    const message = parse(raw)
    if (!isRecord(message)) {
      write(rpcError(-32_700, 'Could not parse that line as JSON. One JSON-RPC message per line.'))
      return
    }
    // Not awaited: a `tools/call` can sit in a browser for two minutes and the client is entitled
    // to send the next request meanwhile — JSON-RPC correlates on id, not on arrival order.
    void dispatch(message).catch((error: unknown) => {
      diag(`failed to answer a request: ${(error as Error).name}`)
    })
  }

  /**
   * The pairing decision, and the only thing standing between a local process and `local` trust.
   * Returns the secret to hand back on a first pairing, `{}` for an already-paired extension, and
   * null for everything else — including every socket that never saw the code.
   */
  const authenticate = (payload: Record<string, unknown>): { secret?: string } | null => {
    if (failures >= ATTEMPTS) return null
    if (credential) {
      const presented = payload['secret']
      return typeof presented === 'string' && secretMatches(presented, credential) ? {} : null
    }
    const presented = payload['code']
    if (typeof presented !== 'string' || !code || !codeMatches(presented, code)) return null
    const secret = mintSecret()
    credential = writeCredential(secret)
    diag(`paired — credential stored in ${credentialFile()} (owner-only)`)
    return { secret }
  }

  /** One socket at a time: a second successful hello is a reconnecting worker, and it wins. */
  const adopt = (next: WebSocket, secret: string | undefined): void => {
    const previous = socket
    socket = null
    if (previous) {
      detach('replaced')
      previous.close(1000, 'replaced')
    }
    socket = next
    lastPong = Date.now()
    heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 2 * heartbeatMs) return next.terminate()
      if (next.readyState === 1) next.send(JSON.stringify({ type: 'ping' }))
    }, heartbeatMs)
    // `secret` rides alongside the attachment protocol's own `welcome` fields rather than inside
    // them: it is the bridge's business, not the host's, exactly as the endpoint token is the
    // relay's and travels beside `hello` there (packages/relay/src/server.ts:471).
    next.send(JSON.stringify({ ...welcome(heartbeatMs), ...(secret ? { secret } : {}) }))
    host.setAttached(true)
    for (const waiter of waking) release(waiter)
    diag('extension attached')
  }

  const detach = (reason: string): void => {
    clearInterval(heartbeat)
    heartbeat = undefined
    // Fails everything in flight at once instead of leaving it on a 120s timer, and never re-sends
    // any of it: a tool can be a write, and a silent retry of a write is worse than a failure a
    // human decides about.
    host.setAttached(false)
    diag(`extension detached (${reason})`)
  }

  const refuse = (candidate: WebSocket, reason: string): void => {
    failures += 1
    candidate.close(1008, reason)
    diag(
      `refused an unpaired connection (${reason}). ${
        credential
          ? `If this is your extension after a reinstall, delete ${credentialFile()} and restart this bridge to pair again.`
          : 'It did not present the pairing code above.'
      }`,
    )
    if (failures >= ATTEMPTS) diag(`too many failed attempts; refusing every connection until restart.`)
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
  wss.on('error', (error) => diag(`socket server error: ${error.name}`))

  wss.on('connection', (candidate: WebSocket) => {
    let adopted = false
    const deadline = setTimeout(() => candidate.close(1008, 'expected hello'), helloMs)
    // ws raises 'error' on an abruptly dropped peer; an unhandled one is an uncaughtException that
    // would take the whole bridge — and the client's MCP session — down with it.
    candidate.on('error', () => candidate.terminate())
    candidate.on('close', () => {
      clearTimeout(deadline)
      if (socket !== candidate) return
      socket = null
      detach('closed')
    })
    candidate.on('message', (raw) => {
      const payload = parse(String(raw))
      const frame = ExtensionFrame.safeParse(payload)
      if (!frame.success) return
      if (!adopted) {
        const paired = frame.data.type === 'hello' && isRecord(payload) ? authenticate(payload) : null
        if (!paired) return refuse(candidate, frame.data.type === 'hello' ? 'not paired' : 'expected hello')
        clearTimeout(deadline)
        adopted = true
        adopt(candidate, paired.secret)
        return
      }
      if (frame.data.type === 'pong') lastPong = Date.now()
      // Everything else is the host's: `surface.push` replaces the cache, `tool.result` settles a
      // call, and a frame it does not know is dropped rather than thrown on.
      else host.receive(frame.data)
    })
  })

  const { server, port } = await listen(options.ports ?? BRIDGE_PORT_RANGE)
  server.on('upgrade', (request, netSocket, head) => {
    if (new URL(request.url ?? '/', 'http://bridge').pathname !== '/ws') return netSocket.destroy()
    wss.handleUpgrade(request, netSocket, head, (ws) => wss.emit('connection', ws, request))
  })

  const reader = createInterface({ input })
  reader.on('line', onLine)

  diag(`listening on ws://127.0.0.1:${port}/ws`)
  if (code) {
    diag('')
    diag(`  Pairing code: ${code}`)
    diag('  Open the Douze extension, choose "Connect a local client", and enter it.')
    diag('  This code is only shown here, and only until you pair.')
    diag('')
  }

  return {
    port,
    code,
    close: async () => {
      reader.close()
      clearInterval(heartbeat)
      for (const waiter of waking) release(waiter)
      host.close()
      for (const client of wss.clients) client.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * Walks the range until one port is free. 127.0.0.1 only, never a wildcard bind: a bridge on
 * 0.0.0.0 would hand `local` trust — destructive tools included — to anything that can route to
 * this machine, and no pairing code is worth that if it ever leaked.
 */
const listen = async (ports: readonly number[]): Promise<{ server: HttpServer; port: number }> => {
  let last: Error | null = null
  for (const candidate of ports) {
    const server = createServer()
    try {
      const port = await bind(server, candidate)
      return { server, port }
    } catch (error) {
      last = error as Error
      server.close()
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(`No free port in ${ports.join(', ')} — ${last?.message ?? 'unknown error'}`)
}

const bind = (server: HttpServer, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve((server.address() as { port: number }).port)
    })
  })

/**
 * Every diagnostic this process emits. stdout belongs to the MCP client's JSON-RPC stream and
 * nothing else — one stray line there and the session is corrupt — which is why nothing in this
 * package logs to the console at all, and a test reads the source to keep it that way.
 */
const diag = (message: string): void => {
  process.stderr.write(`douze-bridge: ${message}\n`)
}

const rpcError = (code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: null,
  error: { code, message },
})

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
