import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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
 * Nearly stateless, and precise about the exception. No payload is logged, and the only thing that
 * reaches disk is the endpoint registry — `RELAY_STATE`, hashes only — so that a restart stops
 * invalidating every user's link. Tool names, descriptions and schemas are held in memory to
 * answer `tools/list` and are never written; the extension re-pushes them on its next dial.
 *
 * The token, the URL secret and the platform bearer are SHA-256 digests wherever they are kept, in
 * memory or in that file, so neither a memory dump nor the file yields a credential that would
 * reach a user's browser.
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
/** `POST /register` is the one unauthenticated route, and a registration is tens of bytes. */
const REGISTER_MAX_BYTES = 4_096
const SWEEP_MS = 30_000
/** How long an over-cap body is read and discarded so its 413 can land. See readBody. */
const LINGER_MS = 5_000
/**
 * A registration nothing ever dialled, with no session, for this many idle windows is nobody's;
 * reap it. A link an extension has held is never reaped by this rule — see `sleep`.
 */
const ENDPOINT_IDLE_WINDOWS = 2
/**
 * How many idle windows an endpoint may go without its extension attached before its **surface**
 * is dropped **whatever the platform is doing**. One hour at the default 10-minute window.
 *
 * The idle rule is not enough on its own, because every `POST /m/<secret>` refreshes `lastSeen`
 * and holds a session open: a hosted connector that goes on polling `tools/list` after the user
 * uninstalled the extension would keep that user's tool names, descriptions and schemas alive in
 * memory forever, listing them to whoever still holds the URL. Liveness has to be a property of
 * the party the surface belongs to, and that is the extension.
 *
 * Six windows rather than two: a browser that is merely closed re-dials within 30 seconds of
 * starting (`chrome.alarms`), so an hour covers a restart, a Chrome update and a lunch break,
 * while an extension that has not managed one dial in that time is not asleep — Chrome is not
 * running at all, or it is gone. The 40-second wake grace is untouched: that is a call waiting
 * for a worker, not an endpoint.
 *
 * What this does NOT do is delete the endpoint — see `sleep`. Adding a connector is a URL pasted
 * into a hosted client by hand, and expiring that URL because someone shut their laptop for the
 * weekend makes it a chore that repeats. The surface dies on this clock; the link does not.
 */
const ENDPOINT_ATTACH_WINDOWS = 6
/**
 * The outer clock: an endpoint no extension has attached to for this long is deleted, secret and
 * all. Dormancy alone would make the URL immortal, and the URL is the whole credential — the
 * extension sends no bearer, so anyone who copied it out of a connector's settings holds a live
 * capability over the user's signed-in accounts that re-arms itself the moment the browser comes
 * back. Deleting the endpoint used to be what quietly rotated a leaked link every time someone
 * shut their laptop overnight, and something has to still bound it.
 *
 * Thirty days, because the only cost of being wrong is re-pasting a URL, and an extension that has
 * not dialled in for a month is not on a long weekend — Douze is uninstalled, the profile is gone,
 * or the laptop is. It also collects the rows an anonymous `POST /register` + one `hello` would
 * otherwise leave in `endpoints.json` for good.
 */
const ENDPOINT_MAX_AGE_MS = 2_592_000_000
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
 * What `initialize` says instead of the usual instructions when there are no tools to list, so an
 * assistant with nothing to offer can say why. Two causes, and guessing wrong is worse than
 * saying nothing: a brand-new user with a live extension and no recipes has an empty surface too,
 * and telling them their browser is offline would send them to fix something that is not broken.
 * The relay knows which it is — the socket is either there or it is not.
 */
const EXTENSION_AWAY =
  'This server is listing no tools because the Douze browser extension is not connected. Tell the ' +
  'user to open Chrome on the computer where Douze is installed, leave it open for about thirty ' +
  'seconds, then start a new conversation. The link is still valid and does not need replacing.'
const NOTHING_RECORDED =
  'This server is listing no tools because no site has been recorded yet. Tell the user to open the ' +
  'Douze extension in their browser, click Watch on a site they are signed into, do the thing they ' +
  'want automated once, then click Done and start a new conversation.'
/**
 * Refusals a hosted MCP client would otherwise never show anyone: it renders a JSON-RPC error and
 * drops an HTTP error body on the floor, so these are delivered as `200 {error:{code:-32000}}`
 * instead. 401/404/413 keep their HTTP meaning — that is what makes a client re-auth or re-init.
 * Everything the extension itself fails is already a JSON-RPC error shaped by the host.
 */
const RPC_VISIBLE = new Set([409, 429])
/**
 * An absolute ceiling on one MCP session, on top of the inactivity rule (ASVS 7.3.2). Idleness
 * alone never expires a session a client polls every nine minutes, and a session is a live
 * capability over somebody's signed-in accounts held by a party we do not control.
 *
 * Twelve hours: longer than any single conversation, so it costs nothing in practice, and short
 * enough that a session id which leaked into a platform's logs is not usable tomorrow. The client
 * cost of being wrong is one 404 and a re-`initialize`, which every target client already does.
 */
const SESSION_MAX_AGE_MS = 43_200_000
/**
 * At most one refusal line per status per this window; whatever else arrives is counted and
 * reported with the next one.
 */
const REFUSAL_LOG_MS = 1_000
/** Comfortably inside Cloudflare's 100 s idle close: a stream that dies silently is worse than none. */
const STREAM_KEEPALIVE_MS = 25_000

interface Session {
  last: number
  /** When `initialize` minted it — the clock the absolute ceiling above is measured on. */
  created: number
  /** Owns MCP for this session: initialize, tools/list, and the correlation of every tool.call. */
  host: McpHost
  /**
   * The client's open `GET` stream, when it has one, and the only way a server-initiated message
   * reaches it. Without this `notifications/tools/list_changed` was generated and dropped: a skill
   * recorded mid-conversation never appeared, because no target client polls `tools/list` — they
   * read it once and cache it. ChatGPT asks for this stream on every session and got a 405 each
   * time.
   */
  stream?: ServerResponse | undefined
  /** Keeps the stream from being closed by an idle proxy. Cleared with the stream. */
  keepalive?: NodeJS.Timeout | undefined
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
   * Last time the **extension** was attached, and the only clock a platform client cannot move.
   * Set at registration, on every `hello`, and refreshed by the sweep for as long as the socket is
   * up, so a long-lived attachment is never mistaken for an abandoned endpoint.
   */
  lastAttached: number
  /**
   * Whether an extension has ever held this endpoint's socket — the line between a link somebody
   * is using and a registration that never became one. Only the former reaches disk, and only the
   * latter is deleted outright by the reaper.
   */
  attached: boolean
  /**
   * The extension has been away long enough that the surface was dropped, and this endpoint is now
   * three hashes waiting for it to come back. Kept so the sweep neither re-drops nor re-logs it.
   */
  dormant: boolean
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
    /** The endpoint this was refused on, where one was identified. There often is not one. */
    readonly ep?: string,
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
  /**
   * Where to keep the endpoint registry across restarts. Unset means the old behaviour — memory
   * only, and every link dies with the process.
   */
  statePath?: string
  sessionIdleMs?: number
  sessionMaxAgeMs?: number
  endpointMaxAgeMs?: number
  heartbeatMs?: number
  requestTimeoutMs?: number
  wakeGraceMs?: number
}): Promise<Relay> {
  // Only the tests set these; production reads the numbers both halves of the protocol agree on.
  const idleMs = options.sessionIdleMs ?? REMOTE_SESSION_IDLE_MS
  const maxAgeMs = options.sessionMaxAgeMs ?? SESSION_MAX_AGE_MS
  const endpointMaxAgeMs = options.endpointMaxAgeMs ?? ENDPOINT_MAX_AGE_MS
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const graceMs = options.wakeGraceMs ?? WAKE_GRACE_MS
  const byToken = new Map<string, Endpoint>()
  const bySecret = new Map<string, Endpoint>()
  const registrations = new Map<string, { count: number; resetAt: number }>()

  /**
   * The endpoint registry, across restarts.
   *
   * Every link used to die with the process, so a deploy — or a crash on a `Restart=always` unit —
   * silently invalidated every user's connector and made each of them re-pair the extension by
   * hand and re-paste a new URL into ChatGPT. That is not a blip, and it happened on every
   * release.
   *
   * WHAT IS WRITTEN IS ONLY HASHES. The token, the URL secret and the platform bearer are stored
   * as SHA-256 digests, exactly as they are held in memory — the file cannot be turned back into a
   * working link, which is the same property `README.md` claims for a memory dump. What is
   * deliberately NOT written is the tool surface: names, descriptions and schemas are the user's
   * own data, they are recoverable from the extension in under 30 seconds, and keeping them off
   * disk means this file holds nothing that describes anybody's dashboards.
   *
   * So a restart costs `tools/list` returning empty until the extension's next dial — the same
   * gap a cold start already had — instead of costing the link itself.
   */
  const statePath = options.statePath
  interface StoredEndpoint {
    tokenHash: string
    secretHash: string
    bearerHash: string | null
  }

  /** The bytes last written, so a save that would rewrite them does nothing. */
  let written = ''
  const save = (): void => {
    if (statePath === undefined) return
    // Only links an extension actually held: a registration nothing ever dialled is a dead row on
    // every future boot, and restoring it would make it indistinguishable from a real pairing.
    const rows: StoredEndpoint[] = [...byToken.values()].filter((endpoint) => endpoint.attached).map((endpoint) => ({
      tokenHash: endpoint.tokenHash,
      secretHash: endpoint.secretHash,
      bearerHash: endpoint.bearerHash === null ? null : endpoint.bearerHash.toString('base64'),
    }))
    const body = JSON.stringify(rows)
    // Most calls change nothing that is written: `register` saves an endpoint the filter above
    // drops, and `reap` saves the removal of one that was never in the file. Both produce the same
    // bytes as last time, and both are reachable by an anonymous caller — so without this an
    // unauthenticated request costs an O(endpoints) serialise and a blocking write.
    if (body === written) return
    // Written to a temporary name and renamed over, so a crash mid-write leaves the previous file
    // whole rather than a truncated one that would drop every endpoint at the next boot. Synchronous
    // because it is sub-kilobyte and only a registration triggers it — and because two of those
    // landing together must not interleave two writes of the same map.
    try {
      writeFileSync(`${statePath}.tmp`, body, { mode: 0o600 })
      renameSync(`${statePath}.tmp`, statePath)
      written = body
    } catch (error) {
      // Never fatal: a relay that cannot write still serves every live link.
      log('state.save_failed', { reason: (error as Error).name })
    }
  }
  // Metrics for now are counters and nothing else: no endpoint is exposed to scrape them, so they
  // are emitted by the sweep when they move and once more on shutdown, and answer "was anything
  // dropped?" for an operator who has only a journal.
  const counters = { registered: 0, requests: 0, refused: 0, waited: 0 }
  const lastReported = { ...counters }
  const refusalLog = new Map<number, { at: number; suppressed: number }>()

  /**
   * Every refusal leaves a line, once per status per second.
   *
   * Without this a 401 on a guessed endpoint token, a 404 on a guessed `/m/<secret>` and a
   * registration flood were all silent: the counters existed but surfaced only in `close()`, which
   * a `Restart=always` unit killed by a signal never reaches, so an operator could not see a brute
   * force live or afterwards (ASVS 16.3.1). What is logged is the status, the refusal's own code,
   * and the endpoint label where one was identified — never a payload, a secret, a path, a session
   * id or a caller address. The payload-free discipline the sweep test enforces is the right one;
   * this stops refusals being invisible without widening it by a single field.
   *
   * Rate-limited because the refusals worth seeing are the ones that arrive thousands at a time,
   * and a line each would be a log flood attack rather than a record of one.
   */
  const logRefusal = (status: number, code: string, ep?: string): void => {
    const now = Date.now()
    const window = refusalLog.get(status)
    if (window && now - window.at < REFUSAL_LOG_MS) {
      window.suppressed += 1
      return
    }
    refusalLog.set(status, { at: now, suppressed: 0 })
    log('request.refused', {
      status,
      code,
      ...(ep === undefined ? {} : { ep }),
      ...(window && window.suppressed > 0 ? { also: window.suppressed } : {}),
    })
  }

  const register = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // ponytail: a fixed in-memory window, keyed per caller. Good enough for one process; swap for
    // a shared store if the relay is ever replicated.
    //
    // Read before the body, charged after it — and the body itself capped at REGISTER_MAX_BYTES,
    // which is what makes that split safe. Reading first would let a caller who never gets
    // charged (an OAuth probe omits `daemon_version`) stream unbounded bytes into the parser for
    // free; charging first would let claude.ai's own discovery exhaust a budget that is shared by
    // every user behind the tunnel. Capping the read costs the attacker 256× and costs the probe
    // nothing.
    const ip = callerAddress(req, options.trustProxy ?? false)
    const now = Date.now()
    const seen = registrations.get(ip)
    const fresh = seen === undefined || seen.resetAt <= now
    if (!fresh && seen.count >= REGISTRATIONS_PER_HOUR) {
      throw new Refusal(429, { error: 'rate_limited', message: 'Too many registrations from this address.' })
    }
    const raw = await jsonBody(req, REGISTER_MAX_BYTES)
    // `/register` is also the default dynamic-client-registration path an MCP client falls back to
    // when OAuth discovery 404s, and claude.ai does exactly that before it will connect. Answering
    // one of those bodies with `201 {token, mcp_path}` told it the relay HAD a sign-in service, so
    // it ran an OAuth flow against endpoints that do not exist and refused to connect at all —
    // while quietly minting a Douze endpoint nobody would ever dial. A registration is ours only
    // if it names a client; anything else gets the 404 that every other unknown path gets, which
    // is what tells an MCP client there is no OAuth here and to connect unauthenticated.
    if (!isRecord(raw) || typeof raw['daemon_version'] !== 'string') {
      throw new Refusal(404, { error: 'not_found' })
    }

    // Charged here: past this line the caller is asking for an endpoint, which is the thing the
    // hourly budget meters.
    if (fresh) registrations.set(ip, { count: 1, resetAt: now + REGISTRATION_WINDOW_MS })
    else seen.count += 1

    // Unauthenticated input, so it is parsed rather than trusted: an unconstrained daemon_version
    // would put an attacker-chosen newline into the log line below, and a non-string bearer_token
    // would reach createHash().update() and take the request down with a TypeError.
    const parsed = RemoteRegistration.safeParse(raw)
    if (!parsed.success) {
      throw new Refusal(400, {
        error: 'bad_request',
        message: 'Expected {daemon_version: string, bearer_token?: string}.',
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
      lastAttached: now,
      attached: false,
      dormant: false,
      surface: [],
      sessions: new Map(),
      inFlight: new Set(),
      waking: new Set(),
    }
    byToken.set(endpoint.tokenHash, endpoint)
    bySecret.set(endpoint.secretHash, endpoint)
    save()
    counters.registered += 1
    log('endpoint.registered', { ep: endpoint.label, client: body.daemon_version })
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
    save()
    log('endpoint.rotated', { ep: endpoint.label })
    json(res, 200, { token, mcp_path: `/m/${secret}` })
  }

  const unregister = (req: IncomingMessage, res: ServerResponse): void => {
    const endpoint = owner(req)
    byToken.delete(endpoint.tokenHash)
    bySecret.delete(endpoint.secretHash)
    save()
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
      // An empty surface is the one failure a hosted client cannot report: with no tool to refuse,
      // the assistant does not say "Douze is offline", it says "I have no tool for that" — or
      // quietly does something else — and the word Douze never reaches the person. They are in a
      // chat window, usually on another device, so the popup, the connect page and every
      // notification are on the wrong machine. What `initialize` carries is the only channel
      // left, and this is the one moment it is worth spending on something other than the tools.
      ...(endpoint.surface.length === 0 ? { instructions: live(endpoint) ? NOTHING_RECORDED : EXTENSION_AWAY } : {}),
      send: (frame) => {
        // Throwing rather than dropping: the host turns it into the offline refusal for this call,
        // where silently swallowing it would leave the caller waiting out the full timeout.
        if (!live(endpoint)) throw new Error('detached')
        endpoint.socket?.send(JSON.stringify(frame))
      },
      // Delivered down this session's open GET stream when it has one. A client with no stream is
      // no worse off than before: it still sees the change on its next `tools/list`.
      notify: (frame) => {
        const open = endpoint.sessions.get(sid)?.stream
        open?.write(`data: ${JSON.stringify(frame)}\n\n`)
        log('mcp.list_changed', { ep: endpoint.label, delivered: open ? 'yes' : 'no' })
      },
    })
    host.setAttached(live(endpoint))
    host.pushSurface(endpoint.surface)
    const session: Session = { last: now, created: now, host }
    endpoint.sessions.set(sid, session)
    return session
  }

  /** Ends the stream a session is holding, so a client whose session is gone re-initializes. */
  const endStream = (session: Session): void => {
    clearInterval(session.keepalive)
    session.keepalive = undefined
    const stream = session.stream
    session.stream = undefined
    if (stream && !stream.writableEnded) stream.end()
  }

  /**
   * `GET /m/<secret>` — streamable HTTP's server-initiated half, which this relay used to answer
   * 405. That was the whole reason a skill recorded mid-conversation never showed up: the host
   * generated `notifications/tools/list_changed`, the callback above had nowhere to put it, and no
   * target client polls `tools/list` — they read it once per connector and cache it. ChatGPT opens
   * this stream on every session, so the refusal was visible in the log as a 405 beside every
   * `mcp.notified`.
   *
   * One stream per session, replacing any earlier one: a client that reconnects its stream is the
   * ordinary case, and keeping the old response object would leave a dead socket being written to.
   */
  const stream = (endpoint: Endpoint, req: IncomingMessage, res: ServerResponse): void => {
    const sid = String(req.headers['mcp-session-id'] ?? '')
    const session = endpoint.sessions.get(sid)
    // Same answer as any other request naming a session that has gone: the client re-initializes.
    if (!session) throw new Refusal(404, { error: 'no_session', message: 'This MCP session has expired.' }, endpoint.label)

    endStream(session)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Cloudflare and nginx both buffer a response without this, which holds every notification
      // until the stream closes — the exact failure this route exists to fix, and a silent one.
      'x-accel-buffering': 'no',
    })
    // A comment line is a valid SSE keepalive and no event, so a client parses nothing from it.
    res.write(': open\n\n')
    session.stream = res
    session.keepalive = setInterval(() => {
      if (res.writableEnded) return
      res.write(': ping\n\n')
    }, STREAM_KEEPALIVE_MS)
    session.keepalive.unref()
    // The client hanging up is normal — a closed tab, a finished conversation — and must not leave
    // an interval running against a dead socket for the life of the session.
    res.on('close', () => {
      if (session.stream === res) endStream(session)
    })
    log('mcp.stream_open', { ep: endpoint.label })
  }

  const closeSession = (endpoint: Endpoint, sid: string): boolean => {
    const session = endpoint.sessions.get(sid)
    if (!session) return false
    endpoint.sessions.delete(sid)
    // Before the host closes: a client left holding a stream on a session that no longer exists
    // would wait for notifications that can never arrive.
    endStream(session)
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
        throw new Refusal(401, { error: 'unauthorized' }, endpoint.label)
      }
    }
    endpoint.lastSeen = Date.now()

    // GET is the server-initiated half of streamable HTTP; see `stream`.
    if (req.method === 'GET') return stream(endpoint, req, res)
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'GET, POST, DELETE')
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
      // Delivered as a 200 so the client renders it, but it is still a refusal and still logged:
      // the reason it is invisible to the HTTP status is exactly why it needs the line.
      logRefusal(error.status, String(error.payload['error']), error.ep)
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
      // At the cap, the OLDEST session is retired to make room rather than the new client being
      // refused. Refusing was a deadlock, and a self-sustaining one: a client whose session the
      // relay had forgotten got a 404, re-initialized exactly as streamable HTTP tells it to —
      // with no session header, so nothing above reclaimed anything — and was met with a 429 it
      // could do nothing about, because the four sessions blocking it were the abandoned ones.
      // Every retry repeated the pair, and only the ten-minute idle sweep ever broke it. Two
      // hosted clients on one link reach four sessions in seconds, so this was the normal case.
      //
      // The cap's job is bounding memory, and evicting bounds it just as well as refusing does.
      if (endpoint.sessions.size >= REMOTE_MAX_SESSIONS) {
        const [oldest] = [...endpoint.sessions.entries()].reduce((a, b) => (b[1].last < a[1].last ? b : a))
        log('mcp.session_evicted', { ep: endpoint.label })
        closeSession(endpoint, oldest)
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
    if (!session) {
      throw new Refusal(404, { error: 'no_session', message: 'This MCP session has expired.' }, endpoint.label)
    }
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
      throw new Refusal(
        409,
        { error: 'duplicate_id', message: 'A request with this id is already in flight.' },
        endpoint.label,
      )
    }
    if (endpoint.inFlight.size >= MAX_IN_FLIGHT) {
      throw new Refusal(
        429,
        { error: 'rate_limited', message: 'Too many calls in flight for this endpoint.' },
        endpoint.label,
      )
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
      if (error instanceof Refusal) {
        logRefusal(error.status, String(error.payload['error']), error.ep)
        return json(res, error.status, error.payload)
      }
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
    /**
     * Unparseable frames counted rather than logged one by one. An unauthenticated socket could
     * emit a line per frame here — this runs BEFORE the token is checked — and unlike every other
     * refusal it bypassed `logRefusal`'s per-second cap. Measured at 20 000 lines from one socket
     * that never authenticated, which is past journald's default burst: the flood evicts the
     * `request.refused` lines an operator watches for somebody guessing endpoint secrets, so it
     * was log evasion as well as disk fill. One line at close says the same thing.
     */
    let dropped = 0
    const deadline = setTimeout(() => {
      counters.refused += 1
      logRefusal(1008, 'hello_timeout')
      socket.close(1008, 'expected hello')
    }, HELLO_TIMEOUT_MS)
    // ws raises 'error' on an abruptly dropped peer, and an unhandled one is an uncaughtException
    // — a single half-open extension connection would take the whole relay down with it.
    socket.on('error', () => socket.terminate())
    socket.on('close', () => {
      clearTimeout(deadline)
      if (dropped > 0) log('extension.dropped_frames', { ep: endpoint?.label ?? 'unauthenticated', count: dropped })
      if (!endpoint || endpoint.socket !== socket) return
      endpoint.socket = null
      detach(endpoint, 'closed')
    })

    socket.on('message', (raw) => {
      const payload = parse(String(raw))
      const frame = ExtensionFrame.safeParse(payload)
      if (!frame.success) {
        dropped += 1
        return
      }
      if (!endpoint) {
        // `hello` carries the endpoint token alongside the attachment protocol's own field; the
        // token is the relay's, not the host's, which is why it is read off the raw frame.
        const token = isRecord(payload) ? payload['token'] : undefined
        const found =
          frame.data.type === 'hello' && typeof token === 'string' ? byToken.get(sha256hex(token)) : undefined
        if (!found) {
          // The one authentication failure that never reaches the HTTP layer, and the one a token
          // guesser would spend all its attempts on. Rate-limited on the same window as the rest.
          counters.refused += 1
          logRefusal(1008, frame.data.type === 'hello' ? 'invalid_relay_token' : 'expected_hello')
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
    endpoint.lastAttached = endpoint.lastPong
    endpoint.dormant = false
    // The first hello is what turns a registration into a link, and the only moment its hashes
    // become worth keeping across a restart.
    if (!endpoint.attached) {
      endpoint.attached = true
      save()
    }
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

  /** Drops an endpoint and everything hanging off it. Whatever was parked is answered as offline. */
  const reap = (endpoint: Endpoint, reason: string): void => {
    byToken.delete(endpoint.tokenHash)
    bySecret.delete(endpoint.secretHash)
    save()
    const socket = endpoint.socket
    endpoint.socket = null
    if (socket) detach(endpoint, reason)
    for (const sid of endpoint.sessions.keys()) closeSession(endpoint, sid)
    wake(endpoint)
    socket?.close(1000, reason)
    log('endpoint.reaped', { ep: endpoint.label, reason })
  }

  /**
   * Drops everything an absent extension leaves behind — the surface, the sessions, whatever is
   * parked — while keeping the three hashes, so the link itself survives. Why the surface goes and
   * the hashes stay: see `ENDPOINT_ATTACH_WINDOWS`.
   *
   * An extension that comes back re-attaches to the endpoint it left, and `pushSurface` sends the
   * `notifications/tools/list_changed` that makes a connected client re-list.
   */
  const sleep = (endpoint: Endpoint, reason: string): void => {
    endpoint.dormant = true
    endpoint.surface = []
    for (const sid of endpoint.sessions.keys()) closeSession(endpoint, sid)
    wake(endpoint)
    log('endpoint.dormant', { ep: endpoint.label, reason })
  }

  const sweep = setInterval(() => {
    const now = Date.now()
    // Both maps below only ever grew: a rate-limit bucket per peer address that outlived its
    // window, and an endpoint whose extension never dialled in and whose owner never called DELETE.
    for (const [ip, seen] of registrations) if (seen.resetAt <= now) registrations.delete(ip)
    for (const endpoint of byToken.values()) {
      if (endpoint.socket) endpoint.lastAttached = now
      for (const [sid, session] of endpoint.sessions) {
        // Inactivity OR age: a client polling every nine minutes refreshes `last` forever, and a
        // session is a live capability over somebody's signed-in accounts. The ceiling is a
        // re-initialize, which every target client already does on a 404, so the cost of being
        // wrong is one extra round trip rather than a broken connector.
        if (session.last > now - idleMs && session.created > now - maxAgeMs) continue
        closeSession(endpoint, sid)
        log('session.expired', { ep: endpoint.label, aged: session.created <= now - maxAgeMs ? 1 : 0 })
      }
      // Before the idle rule, and deliberately not conditioned on it: this is the one clock a
      // platform's polling cannot move, so it is what stops a dead user's surface living forever.
      if (now - endpoint.lastAttached > ENDPOINT_ATTACH_WINDOWS * idleMs) {
        if (!endpoint.attached) reap(endpoint, 'never_attached')
        else if (now - endpoint.lastAttached > endpointMaxAgeMs) reap(endpoint, 'abandoned')
        else if (!endpoint.dormant) sleep(endpoint, 'extension_gone')
        continue
      }
      // Never dialled and nobody talking to it: a registration that never became a link.
      if (endpoint.attached || endpoint.socket || endpoint.sessions.size > 0) continue
      if (now - endpoint.lastSeen > ENDPOINT_IDLE_WINDOWS * idleMs) reap(endpoint, 'unused')
    }
    // A `Restart=always` unit killed by a signal never reaches `close()`, so the counters it logs
    // there would be the only record of a busy hour and would go with the process. Emitted on the
    // sweep instead, and only when something moved, so an idle relay stays quiet.
    if (counters.requests !== lastReported.requests || counters.refused !== lastReported.refused) {
      log('relay.counters', counters)
      Object.assign(lastReported, counters)
    }
  }, Math.min(SWEEP_MS, idleMs))
  sweep.unref()

  // Loopback by default and deliberately no TLS here: the relay is deployed behind a terminator
  // (a Cloudflare tunnel, Fly, a reverse proxy) that owns the certificate and reaches it over
  // localhost. Anything arriving on this port is already inside that boundary — which is only
  // true while it is not bound to a public interface, so widening `host` is opting out of it.
  // Before the port opens, so no request can arrive against an empty registry and be told its
  // perfectly good link does not exist.
  if (statePath !== undefined) {
    try {
      const rows = JSON.parse(await readFile(statePath, 'utf8')) as StoredEndpoint[]
      for (const row of Array.isArray(rows) ? rows : []) {
        if (typeof row?.tokenHash !== 'string' || typeof row.secretHash !== 'string') continue
        const endpoint: Endpoint = {
          // Derived, never stored: it is this prefix by construction wherever a label is set.
          label: row.tokenHash.slice(0, 8),
          tokenHash: row.tokenHash,
          secretHash: row.secretHash,
          bearerHash: typeof row.bearerHash === 'string' ? Buffer.from(row.bearerHash, 'base64') : null,
          socket: null,
          heartbeat: undefined,
          lastPong: 0,
          // Restored as though the extension had just been seen, so the reaper does not delete a
          // link the moment it is loaded because the file records an attachment from yesterday.
          lastSeen: Date.now(),
          lastAttached: Date.now(),
          // Only attached links reach the file, so a restored row is one, and it gets the full
          // attach window to dial back in before it is put to sleep.
          attached: true,
          dormant: false,
          // Not persisted: the extension re-pushes it on its next dial, within 30 seconds of the
          // browser being open. Keeping tool names and descriptions off disk is the point.
          surface: [],
          sessions: new Map(),
          inFlight: new Set(),
          waking: new Set(),
        }
        byToken.set(endpoint.tokenHash, endpoint)
        bySecret.set(endpoint.secretHash, endpoint)
      }
      log('state.loaded', { endpoints: byToken.size })
    } catch (error) {
      // A missing file is the first boot and not a problem. Anything else is: starting with an
      // empty registry silently invalidates every live link, so it is said out loud.
      if ((error as { code?: string }).code !== 'ENOENT') log('state.load_failed', { reason: (error as Error).name })
    }
  }

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve((server.address() as { port: number }).port)
    })
  })
  log('relay.started', { port, persisted: statePath === undefined ? 'no' : 'yes' })

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
 * descriptions in an operator's journal forever. Counts, durations, statuses and refusal codes
 * only — a refused request leaves a line (see `logRefusal`) carrying nothing the caller sent.
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

const jsonBody = async <T>(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<T> => {
  const raw = await readBody(req, max)
  if (raw === null) {
    throw new Refusal(413, { error: 'payload_too_large', message: `The body exceeds ${max} bytes.` })
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
const readBody = (req: IncomingMessage, max = MAX_BODY_BYTES): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > max) {
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
