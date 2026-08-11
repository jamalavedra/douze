import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { HEARTBEAT_MS, REMOTE_SESSION_IDLE_MS, RemoteDaemonMessage, type RemoteRelayMessage } from '@douze/shared'

/**
 * WO-014 T-014.5 — the relay: a stateless forwarder between a hosted MCP client (ChatGPT,
 * claude.ai, Dust — anything speaking streamable HTTP) and one douzed per endpoint, which dials
 * in over a single outbound WebSocket and opens no listener of its own.
 *
 * Stateless means exactly that: every endpoint lives in the map below and dies with the process.
 * Nothing touches disk, no payload is ever logged, and the relay reads only `message.method` and
 * `message.id` — enough to route, and nothing more. It stores hashes of the endpoint token, the
 * URL secret, and the optional platform bearer, so a memory dump of a running relay still does
 * not hand over a credential that would let anyone reach a user's daemon.
 *
 * The trust boundary is honest and narrow: the operator can read and inject MCP traffic. That is
 * disclosed rather than mitigated (README), and self-hosting via DOUZE_RELAY_URL is the remedy.
 */

export interface Relay {
  port: number
  close: () => Promise<void>
}

/** Matches the daemon-side per-call ceiling; a tool call reaching a live dashboard can be slow. */
const REQUEST_TIMEOUT_MS = 120_000
const MAX_BODY_BYTES = 1_048_576
const MAX_IN_FLIGHT = 8
const HELLO_TIMEOUT_MS = 5_000
const REGISTRATIONS_PER_HOUR = 10
const REGISTRATION_WINDOW_MS = 3_600_000
const SWEEP_MS = 30_000

interface Endpoint {
  /** First 8 hex of the token hash — the only endpoint identifier that ever reaches a log line. */
  label: string
  tokenHash: string
  secretHash: string
  bearerHash: Buffer | null
  socket: WebSocket | null
  heartbeat: NodeJS.Timeout | undefined
  lastPong: number
  sessions: Map<string, { last: number }>
  pending: Map<string, { resolve: (message: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>
}

/** An answer the HTTP layer owes the caller; thrown from anywhere in a request's path. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly payload: Record<string, unknown>,
  ) {
    super(String(payload['error']))
    this.name = 'Refusal'
  }
}

const OFFLINE = {
  error: 'daemon_offline',
  message:
    'Douze is not connected to the relay right now. Run `douze status` on the machine that holds ' +
    'your recipes and make sure the daemon is running, then try again.',
}

export async function startRelay(options: { port: number }): Promise<Relay> {
  const byToken = new Map<string, Endpoint>()
  const bySecret = new Map<string, Endpoint>()
  const registrations = new Map<string, { count: number; resetAt: number }>()
  // Metrics for now are counters and nothing else: no endpoint is exposed to scrape them, so
  // they surface once, on shutdown, where they cost nothing and answer "was anything dropped?".
  const counters = { registered: 0, requests: 0, refused: 0, orphaned: 0 }

  const register = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // ponytail: a fixed in-memory window keyed on the socket's peer address, which behind a proxy
    // is the proxy. Swap for a real limiter reading a trusted forwarded-for when one is deployed.
    const ip = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    const seen = registrations.get(ip)
    if (!seen || seen.resetAt <= now) {
      registrations.set(ip, { count: 1, resetAt: now + REGISTRATION_WINDOW_MS })
    } else if (++seen.count > REGISTRATIONS_PER_HOUR) {
      throw new Refusal(429, { error: 'rate_limited', message: 'Too many registrations from this address.' })
    }

    const body = await jsonBody<{ daemon_version?: string; bearer_token?: string }>(req)
    // Two independent randoms: the token authenticates the daemon's socket, the secret is the URL
    // the platform holds. Neither is recoverable from the other, so leaking one URL to a platform
    // log never yields the ability to impersonate the daemon.
    const token = randomBytes(32).toString('base64url')
    const secret = randomBytes(32).toString('base64url')
    const endpoint: Endpoint = {
      label: sha256hex(token).slice(0, 8),
      tokenHash: sha256hex(token),
      secretHash: sha256hex(secret),
      bearerHash: body.bearer_token ? sha256(body.bearer_token) : null,
      socket: null,
      heartbeat: undefined,
      lastPong: 0,
      sessions: new Map(),
      pending: new Map(),
    }
    byToken.set(endpoint.tokenHash, endpoint)
    bySecret.set(endpoint.secretHash, endpoint)
    counters.registered += 1
    log('endpoint.registered', { ep: endpoint.label, daemon: body.daemon_version ?? 'unknown' })
    json(res, 201, { token, mcp_path: `/m/${secret}` })
  }

  /** The token in the header is the proof of ownership for both rotate and delete. */
  const owner = (req: IncomingMessage): Endpoint => {
    const provided = req.headers['x-douze-relay-token']
    const found = typeof provided === 'string' ? byToken.get(sha256hex(provided)) : undefined
    if (!found) throw new Refusal(401, { error: 'unauthorized' })
    return found
  }

  const rotate = (req: IncomingMessage, res: ServerResponse): void => {
    const endpoint = owner(req)
    const token = randomBytes(32).toString('base64url')
    const secret = randomBytes(32).toString('base64url')
    byToken.delete(endpoint.tokenHash)
    bySecret.delete(endpoint.secretHash)
    endpoint.label = sha256hex(token).slice(0, 8)
    endpoint.tokenHash = sha256hex(token)
    endpoint.secretHash = sha256hex(secret)
    byToken.set(endpoint.tokenHash, endpoint)
    bySecret.set(endpoint.secretHash, endpoint)
    // The live socket authenticated with a token that no longer exists. Closing it with 1008 is
    // what makes the daemon re-hello with the token it just received rather than sit there
    // holding a connection the relay would refuse to re-establish.
    const stale = endpoint.socket
    endpoint.socket = null
    if (stale) {
      detach(endpoint, 'rotated')
      stale.close(1008, 'token rotated')
    }
    log('endpoint.rotated', { ep: endpoint.label })
    json(res, 200, { token, mcp_path: `/m/${secret}` })
  }

  const unregister = (req: IncomingMessage, res: ServerResponse): void => {
    const endpoint = owner(req)
    byToken.delete(endpoint.tokenHash)
    bySecret.delete(endpoint.secretHash)
    const socket = endpoint.socket
    endpoint.socket = null
    detach(endpoint, 'unregistered')
    socket?.close(1000, 'unregistered')
    log('endpoint.deleted', { ep: endpoint.label })
    res.writeHead(204).end()
  }

  const send = (endpoint: Endpoint, message: RemoteRelayMessage): void => {
    if (endpoint.socket?.readyState === 1) endpoint.socket.send(JSON.stringify(message))
  }

  /** Waits for the daemon's reply to one JSON-RPC request, correlated by session and id. */
  const forward = (endpoint: Endpoint, sid: string, message: { id?: unknown }): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const key = `${sid}:${String(message.id)}`
      const timer = setTimeout(() => {
        endpoint.pending.delete(key)
        reject(new Refusal(504, { error: 'timeout', message: 'The daemon did not answer in time.' }))
      }, REQUEST_TIMEOUT_MS)
      endpoint.pending.set(key, {
        timer,
        resolve: (reply) => {
          clearTimeout(timer)
          resolve(reply)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      send(endpoint, { type: 'mcp.message', sid, message })
    })

  /**
   * The streamable-HTTP MCP endpoint. Everything a platform client touches lands here, and the
   * only parts of the body read are `method` and `id` — the payload itself is opaque.
   */
  const mcp = async (req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> => {
    const endpoint = bySecret.get(sha256hex(secret))
    if (!endpoint) throw new Refusal(404, { error: 'not_found' })

    if (endpoint.bearerHash) {
      const header = req.headers.authorization ?? ''
      const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (!timingSafeEqual(sha256(presented), endpoint.bearerHash)) throw new Refusal(401, { error: 'unauthorized' })
    }

    // No server-initiated stream in v1: a daemon-side tool change reaches the platform when the
    // client next polls tools/list, which every target client does after a reconnect.
    if (req.method === 'GET') throw new Refusal(405, { error: 'method_not_allowed' })

    if (req.method === 'DELETE') {
      const sid = String(req.headers['mcp-session-id'] ?? '')
      if (endpoint.sessions.delete(sid)) send(endpoint, { type: 'session.close', sid })
      res.writeHead(204).end()
      return
    }
    if (req.method !== 'POST') throw new Refusal(405, { error: 'method_not_allowed' })

    const message = await jsonBody<{ method?: unknown; id?: unknown }>(req)
    if (!endpoint.socket) throw new Refusal(503, OFFLINE)
    if (endpoint.pending.size >= MAX_IN_FLIGHT) {
      throw new Refusal(429, { error: 'rate_limited', message: 'Too many calls in flight for this endpoint.' })
    }
    counters.requests += 1
    const started = Date.now()
    const answered = 'id' in message && message.id !== null && message.id !== undefined

    if (message.method === 'initialize' && answered) {
      const sid = randomUUID()
      endpoint.sessions.set(sid, { last: started })
      send(endpoint, { type: 'session.open', sid })
      const reply = await forward(endpoint, sid, message)
      log('mcp.initialized', { ep: endpoint.label, ms: Date.now() - started })
      json(res, 200, reply, { 'Mcp-Session-Id': sid })
      return
    }

    // Streamable HTTP's own convention: an unknown session is a 404 and the client re-initializes.
    const sid = String(req.headers['mcp-session-id'] ?? '')
    const session = endpoint.sessions.get(sid)
    if (!session) throw new Refusal(404, { error: 'no_session', message: 'This MCP session has expired.' })
    session.last = started

    if (!answered) {
      send(endpoint, { type: 'mcp.message', sid, message })
      log('mcp.notified', { ep: endpoint.label })
      res.writeHead(202).end()
      return
    }
    const reply = await forward(endpoint, sid, message)
    log('mcp.answered', { ep: endpoint.label, ms: Date.now() - started })
    json(res, 200, reply)
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://relay').pathname
    if (path === '/health' && req.method === 'GET') return json(res, 200, { ok: true })
    if (path === '/register' && req.method === 'POST') return register(req, res)
    if (path === '/register' && req.method === 'DELETE') return unregister(req, res)
    if (path === '/rotate' && req.method === 'POST') return rotate(req, res)
    if (path.startsWith('/m/')) return mcp(req, res, path.slice(3))
    throw new Refusal(404, { error: 'not_found' })
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      counters.refused += 1
      if (error instanceof Refusal) return json(res, error.status, error.payload)
      log('relay.failed', { reason: (error as Error).name })
      json(res, 500, { error: 'relay_failed' })
    })
  })

  /** Everything that outlives a socket: in-flight calls fail now, sessions are gone with it. */
  const detach = (endpoint: Endpoint, reason: string): void => {
    clearInterval(endpoint.heartbeat)
    endpoint.heartbeat = undefined
    for (const [key, waiter] of endpoint.pending) {
      endpoint.pending.delete(key)
      // Waiting out the 120s timeout for a failure already known is the opposite of legible.
      waiter.reject(new Refusal(502, OFFLINE))
    }
    // A reconnecting daemon builds fresh MCP server instances and knows none of these ids.
    endpoint.sessions.clear()
    log('daemon.detached', { ep: endpoint.label, reason })
  }

  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('error', (error) => log('relay.failed', { reason: error.message }))

  wss.on('connection', (socket) => {
    let endpoint: Endpoint | null = null
    const deadline = setTimeout(() => socket.close(1008, 'expected hello'), HELLO_TIMEOUT_MS)
    // ws raises 'error' on an abruptly dropped peer, and an unhandled one is an uncaughtException
    // — a single half-open daemon connection would take the whole relay down with it.
    socket.on('error', () => socket.terminate())
    socket.on('close', () => {
      clearTimeout(deadline)
      if (!endpoint || endpoint.socket !== socket) return
      endpoint.socket = null
      detach(endpoint, 'closed')
    })

    socket.on('message', (raw) => {
      const frame = RemoteDaemonMessage.safeParse(parse(String(raw)))
      if (!frame.success) {
        log('daemon.dropped_frame', { bytes: String(raw).length })
        return
      }
      if (!endpoint) {
        if (frame.data.type !== 'hello') {
          socket.close(1008, 'expected hello')
          return
        }
        const found = byToken.get(sha256hex(frame.data.token))
        if (!found) {
          socket.close(1008, 'invalid relay token')
          return
        }
        clearTimeout(deadline)
        endpoint = adopt(found, socket)
        socket.send(JSON.stringify({ type: 'welcome', heartbeat_ms: HEARTBEAT_MS } satisfies RemoteRelayMessage))
        return
      }
      switch (frame.data.type) {
        case 'pong':
          endpoint.lastPong = Date.now()
          return
        case 'mcp.message':
          settle(endpoint, frame.data.sid, frame.data.message)
          return
        case 'session.closed':
          endpoint.sessions.delete(frame.data.sid)
          return
        default:
          return
      }
    })
  })

  /** One socket per endpoint: a second hello is a reconnecting daemon, and it wins. */
  const adopt = (endpoint: Endpoint, socket: WebSocket): Endpoint => {
    const previous = endpoint.socket
    endpoint.socket = null
    if (previous) {
      detach(endpoint, 'replaced')
      previous.close(1000, 'replaced')
    }
    endpoint.socket = socket
    endpoint.lastPong = Date.now()
    endpoint.heartbeat = setInterval(() => {
      if (Date.now() - endpoint.lastPong > 2 * HEARTBEAT_MS) {
        socket.terminate()
        return
      }
      send(endpoint, { type: 'ping' })
    }, HEARTBEAT_MS)
    log('daemon.connected', { ep: endpoint.label })
    return endpoint
  }

  const settle = (endpoint: Endpoint, sid: string, message: unknown): void => {
    const key = `${sid}:${String((message as { id?: unknown } | null)?.id)}`
    const waiter = endpoint.pending.get(key)
    if (!waiter) {
      // A server-initiated notification (tools/list_changed and friends) with no request waiting
      // for it. There is no stream to put it on in v1, so it is counted and dropped.
      counters.orphaned += 1
      log('mcp.dropped', { ep: endpoint.label })
      return
    }
    endpoint.pending.delete(key)
    waiter.resolve(message)
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - REMOTE_SESSION_IDLE_MS
    for (const endpoint of byToken.values()) {
      for (const [sid, session] of endpoint.sessions) {
        if (session.last > cutoff) continue
        endpoint.sessions.delete(sid)
        send(endpoint, { type: 'session.close', sid })
        log('session.expired', { ep: endpoint.label })
      }
    }
  }, SWEEP_MS)
  sweep.unref()

  // 0.0.0.0, and deliberately no TLS here: the relay is deployed behind a terminator (Fly, Render,
  // a reverse proxy) that owns the certificate. Anything reaching this port is already inside it.
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(options.port, '0.0.0.0', () => {
      server.removeListener('error', onError)
      resolve((server.address() as { port: number }).port)
    })
  })
  log('relay.started', { port })

  return {
    port,
    close: async () => {
      clearInterval(sweep)
      for (const endpoint of byToken.values()) clearInterval(endpoint.heartbeat)
      // wss.close() only stops new upgrades; a connected daemon otherwise holds the process open.
      for (const client of wss.clients) client.terminate()
      wss.close()
      server.closeIdleConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      log('relay.stopped', counters)
    },
  }
}

/**
 * One line per event: when, what, how big, and which endpoint by hash prefix. No payloads, no
 * tool names, no session ids, and no secret in any form — the sweep test in relay.test.ts holds
 * this line, because a relay log is the one place a bearer token would sit in plaintext forever.
 */
const log = (event: string, fields: Record<string, string | number> = {}): void => {
  const tail = Object.entries(fields)
    .map(([key, value]) => ` ${key}=${value}`)
    .join('')
  process.stderr.write(`${new Date().toISOString()} ${event}${tail}\n`)
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()
const sha256hex = (value: string): string => createHash('sha256').update(value).digest('hex')

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const jsonBody = async <T>(req: IncomingMessage): Promise<T> => {
  const raw = await readBody(req)
  if (raw === null) {
    throw new Refusal(413, { error: 'payload_too_large', message: `The body exceeds ${MAX_BODY_BYTES} bytes.` })
  }
  const body = parse(raw.toString('utf8'))
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Refusal(400, { error: 'bad_request', message: 'Expected one JSON object.' })
  }
  return body as T
}

/** null once the cap is passed. The rest is drained rather than destroyed, so the 413 arrives. */
const readBody = (req: IncomingMessage): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        over = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)))
    // An aborted upload never emits 'end'; without this the handler awaits forever.
    req.on('error', reject)
  })
