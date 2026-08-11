import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { HEARTBEAT_MS, REMOTE_MAX_SESSIONS, REMOTE_SESSION_IDLE_MS, RemoteRegistration } from '@douze/shared'
import { ExtensionFrame, McpHost, welcome, type AttachedTool } from '@douze/mcp-host'

/**
 * WO-015 T-015.7 — the relay: a hosted MCP endpoint for clients that cannot run a local process
 * (ChatGPT, claude.ai web and mobile, Dust — anything speaking streamable HTTP), paired with one
 * Douze browser extension per endpoint, which dials in over a single outbound WebSocket and opens
 * no listener of its own.
 *
 * It **terminates MCP itself**, one `McpHost` per session, rather than forwarding opaque JSON-RPC
 * to something that owns the session on the far side (WO-014 did that, with a daemon there). The
 * attached party is now an MV3 service worker Chrome evicts at will, so it can hold no session
 * state and cannot be woken by an inbound frame: `initialize` and `tools/list` are answered here,
 * from the surface the extension last pushed, and only `tools/call` needs the browser awake.
 *
 * What that buys: a connector added while Chrome is closed lists its tools instead of looking
 * broken, and a call that arrives at a sleeping worker waits out WAKE_GRACE_MS for it to come back
 * rather than reporting a browser that is merely asleep as one that is gone.
 *
 * Still stateless in the sense that matters: every endpoint lives in the maps below and dies with
 * the process, nothing touches disk, and no payload is logged. What is new — and disclosed in the
 * README rather than softened — is that the relay now holds each endpoint's tool names,
 * descriptions and schemas in memory in order to answer `tools/list`. It stores hashes of the
 * endpoint token, the URL secret, and the optional platform bearer, so a memory dump still does
 * not hand over a credential that would reach a user's browser.
 */

export interface Relay {
  port: number
  close: () => Promise<void>
}

/** Matches the host's per-call ceiling; a tool call reaching a live dashboard can be slow. */
const REQUEST_TIMEOUT_MS = 120_000
const MAX_BODY_BYTES = 1_048_576
const MAX_IN_FLIGHT = 8
const HELLO_TIMEOUT_MS = 5_000
const REGISTRATIONS_PER_HOUR = 10
const REGISTRATION_WINDOW_MS = 3_600_000
const SWEEP_MS = 30_000
/** How long an over-cap body is read and discarded so its 413 can land. See readBody. */
const LINGER_MS = 5_000
/** An endpoint with no extension and no session for this many idle windows is nobody's; reap it. */
const ENDPOINT_IDLE_WINDOWS = 2
/**
 * How long a `tools/call` waits for a detached extension before it is answered as offline.
 *
 * An evicted MV3 service worker cannot be woken from outside — no inbound frame reaches a worker
 * that is not running — and the only thing that revives it on its own is `chrome.alarms`, whose
 * minimum period is 30 seconds. So any grace shorter than that reports a browser which is merely
 * asleep as one that is gone. This is that floor plus the seconds a cold worker needs to boot and
 * re-dial, and it stays well inside the 120 s per-call ceiling.
 *
 * `initialize` and `tools/list` never wait: they are answered from the cached surface, which is
 * the whole point of the host owning the session.
 */
const WAKE_GRACE_MS = 40_000
/**
 * Refusals a hosted MCP client would otherwise never show anyone: it renders a JSON-RPC error and
 * drops an HTTP error body on the floor, so these are delivered as `200 {error:{code:-32000}}`
 * instead. 401/404/413 keep their HTTP meaning — that is what makes a client re-auth or re-init.
 * Everything the extension itself fails is already a JSON-RPC error shaped by the host.
 */
const RPC_VISIBLE = new Set([409, 429])

interface Session {
  last: number
  /** Owns MCP for this session: initialize, tools/list, and the correlation of every tool.call. */
  host: McpHost
}

interface Endpoint {
  /** First 8 hex of the token hash — the only endpoint identifier that ever reaches a log line. */
  label: string
  tokenHash: string
  secretHash: string
  bearerHash: Buffer | null
  socket: WebSocket | null
  heartbeat: NodeJS.Timeout | undefined
  lastPong: number
  /** Last time the extension or a platform client touched this endpoint, for the reaper below. */
  lastSeen: number
  /**
   * One cached surface per endpoint, not per session: the extension pushes it once per connect,
   * every live session is fanned out from it, and a session created later is seeded from it. That
   * is what lets a connector added while Chrome is closed list its tools.
   */
  surface: AttachedTool[]
  sessions: Map<string, Session>
  /** Waiter keys of calls being awaited: both the in-flight cap and the duplicate-id guard. */
  inFlight: Set<string>
  /** Calls parked in the wake grace, resolved by the next `hello` or by their own timer. */
  waking: Set<{ resolve: () => void; timer: NodeJS.Timeout }>
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

export async function startRelay(options: {
  port: number
  /** Defaults to loopback; only widen it when nothing else terminates TLS in front. */
  host?: string
  /**
   * Read the caller's address from `cf-connecting-ip`/`x-forwarded-for` instead of the socket.
   * Set this only when the port is reachable exclusively through a proxy that overwrites those
   * headers — otherwise a caller forges the header and gets a rate-limit bucket per request.
   * Without it, every request behind a tunnel shares the proxy's one bucket.
   */
  trustProxy?: boolean
  sessionIdleMs?: number
  heartbeatMs?: number
  requestTimeoutMs?: number
  wakeGraceMs?: number
}): Promise<Relay> {
  // Only the tests set these; production reads the numbers both halves of the protocol agree on.
  const idleMs = options.sessionIdleMs ?? REMOTE_SESSION_IDLE_MS
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const graceMs = options.wakeGraceMs ?? WAKE_GRACE_MS
  const byToken = new Map<string, Endpoint>()
  const bySecret = new Map<string, Endpoint>()
  const registrations = new Map<string, { count: number; resetAt: number }>()
  // Metrics for now are counters and nothing else: no endpoint is exposed to scrape them, so
  // they surface once, on shutdown, where they cost nothing and answer "was anything dropped?".
  const counters = { registered: 0, requests: 0, refused: 0, waited: 0 }

  const register = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // ponytail: a fixed in-memory window, keyed per caller. Good enough for one process; swap for
    // a shared store if the relay is ever replicated.
    const ip = callerAddress(req, options.trustProxy ?? false)
    const now = Date.now()
    const seen = registrations.get(ip)
    if (!seen || seen.resetAt <= now) {
      registrations.set(ip, { count: 1, resetAt: now + REGISTRATION_WINDOW_MS })
    } else if (++seen.count > REGISTRATIONS_PER_HOUR) {
      throw new Refusal(429, { error: 'rate_limited', message: 'Too many registrations from this address.' })
    }

    // Unauthenticated input, so it is parsed rather than trusted: an unconstrained daemon_version
    // would put an attacker-chosen newline into the log line below, and a non-string bearer_token
    // would reach createHash().update() and take the request down with a TypeError.
    const parsed = RemoteRegistration.safeParse(await jsonBody(req))
    if (!parsed.success) {
      throw new Refusal(400, {
        error: 'bad_request',
        message: 'Expected {daemon_version?: string, bearer_token?: string}.',
      })
    }
    const body = parsed.data
    // Two independent randoms: the token authenticates the extension's socket, the secret is the
    // URL the platform holds. Neither is recoverable from the other, so leaking one URL to a
    // platform log never yields the ability to impersonate the extension.
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
      lastSeen: now,
      surface: [],
      sessions: new Map(),
      inFlight: new Set(),
      waking: new Set(),
    }
    byToken.set(endpoint.tokenHash, endpoint)
    bySecret.set(endpoint.secretHash, endpoint)
    counters.registered += 1
    log('endpoint.registered', { ep: endpoint.label, client: body.daemon_version ?? 'unknown' })
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
    // what makes the extension re-hello with the token it just received rather than sit there
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
    for (const sid of endpoint.sessions.keys()) closeSession(endpoint, sid)
    // Nothing is coming back for a call parked in the wake grace on an endpoint that no longer
    // exists: released now, and the host answers it as offline.
    wake(endpoint)
    socket?.close(1000, 'unregistered')
    log('endpoint.deleted', { ep: endpoint.label })
    res.writeHead(204).end()
  }

  /**
   * One MCP session, terminated here. The host answers `initialize` and `tools/list` on its own
   * and only reaches the extension for a `tools/call`; seeding it with the endpoint's cached
   * surface is what makes a session opened while the browser is closed useful rather than empty.
   */
  const openSession = (endpoint: Endpoint, sid: string, now: number): Session => {
    const host = new McpHost({
      trust: 'remote',
      callTimeoutMs: timeoutMs,
      send: (frame) => {
        // Throwing rather than dropping: the host turns it into the offline refusal for this call,
        // where silently swallowing it would leave the caller waiting out the full timeout.
        if (!live(endpoint)) throw new Error('detached')
        endpoint.socket?.send(JSON.stringify(frame))
      },
      // There is no server-initiated stream in v1 (GET is 405), so a list change is recorded and
      // the client sees it the next time it polls tools/list — which every target client does.
      notify: () => log('mcp.list_changed', { ep: endpoint.label }),
    })
    host.setAttached(live(endpoint))
    host.pushSurface(endpoint.surface)
    const session: Session = { last: now, host }
    endpoint.sessions.set(sid, session)
    return session
  }

  const closeSession = (endpoint: Endpoint, sid: string): boolean => {
    const session = endpoint.sessions.get(sid)
    if (!session) return false
    endpoint.sessions.delete(sid)
    // Fails whatever that session had in flight instead of leaving it on a 120s timer.
    session.host.close()
    return true
  }

  /** The extension's one surface, fanned out to every session that already exists. */
  const pushSurface = (endpoint: Endpoint, tools: AttachedTool[]): void => {
    endpoint.surface = tools
    for (const session of endpoint.sessions.values()) session.host.pushSurface(tools)
    // The count, never the names: this is the metadata the relay now holds and must not log.
    log('surface.pushed', { ep: endpoint.label, tools: tools.length })
  }

  /**
   * Parks a call until the extension re-attaches or the grace runs out. Never re-sends anything —
   * the call has not been sent yet; a call already in flight when the socket dropped is failed by
   * `setAttached(false)` and stays failed, because a tool can be a write.
   */
  const waitForAttach = (endpoint: Endpoint): Promise<void> => {
    counters.waited += 1
    log('extension.waking', { ep: endpoint.label, grace_ms: graceMs })
    return new Promise<void>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          endpoint.waking.delete(waiter)
          resolve()
        }, graceMs),
      }
      waiter.timer.unref()
      endpoint.waking.add(waiter)
    })
  }

  const wake = (endpoint: Endpoint): void => {
    for (const waiter of endpoint.waking) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    endpoint.waking.clear()
  }

  /**
   * The streamable-HTTP MCP endpoint. Everything a platform client touches lands here, and every
   * JSON-RPC message is answered by this endpoint's own host.
   */
  const mcp = async (req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> => {
    const endpoint = bySecret.get(sha256hex(secret))
    if (!endpoint) throw new Refusal(404, { error: 'not_found' })

    if (endpoint.bearerHash) {
      const header = req.headers.authorization ?? ''
      const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (!timingSafeEqual(sha256(presented), endpoint.bearerHash)) {
        res.setHeader('WWW-Authenticate', 'Bearer')
        throw new Refusal(401, { error: 'unauthorized' })
      }
    }
    endpoint.lastSeen = Date.now()

    // No server-initiated stream in v1: a tool change reaches the platform when the client next
    // polls tools/list, which every target client does after a reconnect.
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'POST, DELETE')
      throw new Refusal(405, { error: 'method_not_allowed' })
    }

    if (req.method === 'DELETE') {
      closeSession(endpoint, String(req.headers['mcp-session-id'] ?? ''))
      res.writeHead(204).end()
      return
    }

    const message = await jsonBody<{ method?: unknown; id?: unknown }>(req)
    const answered = 'id' in message && message.id !== null && message.id !== undefined
    const initializing = message.method === 'initialize' && answered
    try {
      await exchange(endpoint, req, res, message)
    } catch (error) {
      if (!(error instanceof Refusal) || initializing || !answered) throw error
      if (!RPC_VISIBLE.has(error.status)) throw error
      counters.refused += 1
      json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32_000, message: error.payload['message'] } })
    }
  }

  /** One POST to `/m/<secret>`, from the in-flight cap down to the host's answer. */
  const exchange = async (
    endpoint: Endpoint,
    req: IncomingMessage,
    res: ServerResponse,
    message: { method?: unknown; id?: unknown },
  ): Promise<void> => {
    counters.requests += 1
    const started = Date.now()
    const answered = 'id' in message && message.id !== null && message.id !== undefined
    const header = String(req.headers['mcp-session-id'] ?? '')

    if (message.method === 'initialize' && answered) {
      // A client re-initializing over a session it already holds gets that one closed rather than
      // orphaned: without this the previous host survives until the session idles out.
      closeSession(endpoint, header)
      if (endpoint.sessions.size >= REMOTE_MAX_SESSIONS) {
        throw new Refusal(429, { error: 'rate_limited', message: 'Too many MCP sessions open for this endpoint.' })
      }
      const sid = randomUUID()
      const session = openSession(endpoint, sid, started)
      const reply = await session.host.handle(message)
      log('mcp.initialized', { ep: endpoint.label, ms: Date.now() - started })
      json(res, 200, reply, { 'Mcp-Session-Id': sid })
      return
    }

    // Streamable HTTP's own convention: an unknown session is a 404 and the client re-initializes.
    const session = endpoint.sessions.get(header)
    if (!session) throw new Refusal(404, { error: 'no_session', message: 'This MCP session has expired.' })
    session.last = started

    if (!answered) {
      void session.host.handle(message)
      log('mcp.notified', { ep: endpoint.label })
      res.writeHead(202).end()
      return
    }

    // Reusing an id that is still in flight would let one caller's answer settle another's request.
    const key = waiterKey(header, message.id)
    if (endpoint.inFlight.has(key)) {
      throw new Refusal(409, { error: 'duplicate_id', message: 'A request with this id is already in flight.' })
    }
    if (endpoint.inFlight.size >= MAX_IN_FLIGHT) {
      throw new Refusal(429, { error: 'rate_limited', message: 'Too many calls in flight for this endpoint.' })
    }
    endpoint.inFlight.add(key)
    try {
      // Only a call needs the browser: initialize and tools/list are already answered above and
      // below from cache, and making them wait would stall a client that is merely listing tools.
      if (message.method === 'tools/call' && !live(endpoint)) await waitForAttach(endpoint)
      const reply = await session.host.handle(message)
      log('mcp.answered', { ep: endpoint.label, ms: Date.now() - started })
      json(res, 200, reply)
    } finally {
      endpoint.inFlight.delete(key)
    }
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

  /**
   * Everything that outlives a socket. Sessions **survive** it — they belong to the relay now, and
   * a client must still be able to list tools with the browser closed — but each host is told it
   * is detached, which fails what it had in flight at once rather than on a 120s timer. Those
   * calls are never re-sent when the extension returns: a tool can be a write.
   */
  const detach = (endpoint: Endpoint, reason: string): void => {
    clearInterval(endpoint.heartbeat)
    endpoint.heartbeat = undefined
    for (const session of endpoint.sessions.values()) session.host.setAttached(false)
    log('extension.detached', { ep: endpoint.label, reason })
  }

  // maxPayload matches the HTTP body cap; ws defaults to 100MB, which no frame here ever needs.
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_BODY_BYTES })
  // The name, not the message: an error string is the one unbounded value that could reach a line.
  wss.on('error', (error) => log('relay.failed', { reason: error.name }))

  wss.on('connection', (socket) => {
    let endpoint: Endpoint | null = null
    const deadline = setTimeout(() => socket.close(1008, 'expected hello'), HELLO_TIMEOUT_MS)
    // ws raises 'error' on an abruptly dropped peer, and an unhandled one is an uncaughtException
    // — a single half-open extension connection would take the whole relay down with it.
    socket.on('error', () => socket.terminate())
    socket.on('close', () => {
      clearTimeout(deadline)
      if (!endpoint || endpoint.socket !== socket) return
      endpoint.socket = null
      detach(endpoint, 'closed')
    })

    socket.on('message', (raw) => {
      const payload = parse(String(raw))
      const frame = ExtensionFrame.safeParse(payload)
      if (!frame.success) {
        log('extension.dropped_frame', { bytes: String(raw).length })
        return
      }
      if (!endpoint) {
        // `hello` carries the endpoint token alongside the attachment protocol's own field; the
        // token is the relay's, not the host's, which is why it is read off the raw frame.
        const token = isRecord(payload) ? payload['token'] : undefined
        const found =
          frame.data.type === 'hello' && typeof token === 'string' ? byToken.get(sha256hex(token)) : undefined
        if (!found) {
          socket.close(1008, frame.data.type === 'hello' ? 'invalid relay token' : 'expected hello')
          return
        }
        clearTimeout(deadline)
        endpoint = adopt(found, socket)
        socket.send(JSON.stringify(welcome(heartbeatMs)))
        return
      }
      switch (frame.data.type) {
        case 'pong':
          endpoint.lastPong = Date.now()
          return
        case 'surface.push':
          pushSurface(endpoint, frame.data.tools)
          return
        case 'tool.result':
          // Fanned out rather than routed: every call id is minted by a host and unique across the
          // attachment, so at most one session knows this one and the rest ignore it.
          for (const session of endpoint.sessions.values()) session.host.receive(frame.data)
          return
        default:
          return
      }
    })
  })

  /** One socket per endpoint: a second hello is a reconnecting extension, and it wins. */
  const adopt = (endpoint: Endpoint, socket: WebSocket): Endpoint => {
    const previous = endpoint.socket
    endpoint.socket = null
    if (previous) {
      detach(endpoint, 'replaced')
      previous.close(1000, 'replaced')
    }
    endpoint.socket = socket
    endpoint.lastPong = Date.now()
    endpoint.lastSeen = endpoint.lastPong
    endpoint.heartbeat = setInterval(() => {
      if (Date.now() - endpoint.lastPong > 2 * heartbeatMs) {
        socket.terminate()
        return
      }
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ping' }))
    }, heartbeatMs)
    // Sessions outlived the disconnect, so they are told the browser is back before anything
    // parked in the grace is released into a host that would otherwise refuse it as offline.
    for (const session of endpoint.sessions.values()) session.host.setAttached(true)
    wake(endpoint)
    log('extension.connected', { ep: endpoint.label })
    return endpoint
  }

  const sweep = setInterval(() => {
    const now = Date.now()
    // Both maps below only ever grew: a rate-limit bucket per peer address that outlived its
    // window, and an endpoint whose extension never dialled in and whose owner never called DELETE.
    for (const [ip, seen] of registrations) if (seen.resetAt <= now) registrations.delete(ip)
    for (const endpoint of byToken.values()) {
      for (const [sid, session] of endpoint.sessions) {
        if (session.last > now - idleMs) continue
        closeSession(endpoint, sid)
        log('session.expired', { ep: endpoint.label })
      }
      if (endpoint.socket || endpoint.sessions.size > 0) continue
      if (now - endpoint.lastSeen <= ENDPOINT_IDLE_WINDOWS * idleMs) continue
      byToken.delete(endpoint.tokenHash)
      bySecret.delete(endpoint.secretHash)
      log('endpoint.reaped', { ep: endpoint.label })
    }
  }, Math.min(SWEEP_MS, idleMs))
  sweep.unref()

  // Loopback by default and deliberately no TLS here: the relay is deployed behind a terminator
  // (a Cloudflare tunnel, Fly, a reverse proxy) that owns the certificate and reaches it over
  // localhost. Anything arriving on this port is already inside that boundary — which is only
  // true while it is not bound to a public interface, so widening `host` is opting out of it.
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve((server.address() as { port: number }).port)
    })
  })
  log('relay.started', { port })

  return {
    port,
    close: async () => {
      clearInterval(sweep)
      for (const endpoint of byToken.values()) {
        clearInterval(endpoint.heartbeat)
        for (const sid of endpoint.sessions.keys()) closeSession(endpoint, sid)
        wake(endpoint)
      }
      // wss.close() only stops new upgrades; a connected extension otherwise holds the process open.
      for (const client of wss.clients) client.terminate()
      wss.close()
      // All, not just idle: a client mid-upload holds a connection that is anything but idle, and
      // server.close() would wait on it for as long as that client cared to keep it open.
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      log('relay.stopped', counters)
    },
  }
}

/**
 * One line per event: when, what, how big, and which endpoint by hash prefix. No payloads, no tool
 * names, no descriptions, no session ids, and no secret in any form — the sweep test in
 * relay.test.ts holds this line, and it matters more than it did in WO-014: the relay now holds a
 * whole tool surface in memory, so a careless log line would put a user's recipe names and
 * descriptions in an operator's journal forever. Counts and durations only.
 */
const log = (event: string, fields: Record<string, string | number> = {}): void => {
  const tail = Object.entries(fields)
    .map(([key, value]) => ` ${key}=${value}`)
    .join('')
  process.stderr.write(`${new Date().toISOString()} ${event}${tail}\n`)
}

/**
 * Who to charge a registration to. Behind a tunnel every request arrives from the proxy, so the
 * socket address is one bucket for the whole internet — the first legitimate user of the hour
 * exhausts it for everyone. The headers are only meaningful where the proxy sets them and the
 * port is reachable no other way, which is why reading them is opt-in rather than automatic.
 * Never logged: an address is personal data and the log line carries no payload of any kind.
 */
const callerAddress = (req: IncomingMessage, trustProxy: boolean): string => {
  if (!trustProxy) return req.socket.remoteAddress ?? 'unknown'
  const forwarded = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return first && first.length <= 64 ? first : (req.socket.remoteAddress ?? 'unknown')
}

/**
 * JSON-RPC ids keep their type, so `1` and `"1"` are two different calls and two objects are not
 * the same call just because both stringify to `[object Object]`. Correlating on the string alone
 * would let one caller's request pass the duplicate-id guard on another's key.
 */
const waiterKey = (sid: string, id: unknown): string => `${sid}:${typeof id}:${String(id)}`

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

/**
 * An attachment that can carry a frame right now. A socket in CLOSING is not one: without this,
 * a call arriving between the peer's close and the relay's own 'close' event would be refused as
 * offline instead of parked for the worker that is on its way back.
 */
const live = (endpoint: { socket: WebSocket | null }): boolean => endpoint.socket?.readyState === 1

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const jsonBody = async <T>(req: IncomingMessage): Promise<T> => {
  const raw = await readBody(req)
  if (raw === null) {
    throw new Refusal(413, { error: 'payload_too_large', message: `The body exceeds ${MAX_BODY_BYTES} bytes.` })
  }
  const body = parse(raw.toString('utf8'))
  if (!isRecord(body)) {
    throw new Refusal(400, { error: 'bad_request', message: 'Expected one JSON object.' })
  }
  return body as T
}

/**
 * null once the cap is passed, and owed to the caller right then rather than at the end of the
 * upload: nothing past 1MB is ever held, and a client that promises 20MB and then dawdles cannot
 * keep the handler waiting on a body nobody is going to read.
 *
 * What is left flowing is the socket, not a buffer. Pausing or destroying it here is what breaks:
 * closing a connection with unread data in its receive queue sends an RST, and the RST discards
 * the 413 the caller is in the middle of writing — the client sees EPIPE and never learns why.
 * So the rest is read and dropped on the floor (nginx calls this lingering close) for a bounded
 * few seconds, which is long enough for the refusal to land and short enough to not be a handle
 * anyone can hold.
 */
const readBody = (req: IncomingMessage): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        over = true
        chunks.length = 0
        const linger = setTimeout(() => req.destroy(), LINGER_MS)
        linger.unref()
        req.on('close', () => clearTimeout(linger))
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    // An aborted upload never emits 'end'; without these the handler awaits forever.
    req.on('close', () => resolve(null))
    req.on('error', reject)
  })
