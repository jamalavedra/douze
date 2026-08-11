import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { Hono } from 'hono'
import { ClientMessage, Exchange, DouzeError, PORT_RANGE, RelayResponse } from '@douze/shared'
import { CaptureStore } from './capture-store.js'
import { RecipeRegistry } from './registry.js'
import { RelayBridge } from './relay.js'
import {
  ensureHome,
  extensionIdOf,
  installToken,
  isAlive,
  pinExtension,
  pinnedExtension,
  readRuntime,
  writeRuntime,
} from './paths.js'
import { importHar } from './har-import.js'
import { DriftWatcher } from './doctor.js'

export interface Daemon {
  port: number
  close: () => Promise<void>
  registry: RecipeRegistry
  store: CaptureStore
  bridge: RelayBridge
  drift: DriftWatcher
}

/** Reported to the extension by /pair so it can tell a stale daemon from a current one. */
const DOUZED_VERSION = '0.1.0'

/**
 * douzed — the only always-on Douze process (TR-5, AC-RUN-003.1). It holds the extension
 * WebSocket, the recipe registry, the capture store, and the review UI.
 *
 * ADR-006 still holds: @douze/studio — inference, model calls, the review page — is never
 * statically imported here. The review routes `await import()` it, so an ordinary relay call
 * never loads the inference engine.
 */
export async function startDaemon(options: { port?: number } = {}): Promise<Daemon> {
  const paths = ensureHome()

  // AC-RUN-003.2 — a live instance means this one exits rather than binding a second port.
  const existing = readRuntime()
  if (isAlive(existing)) {
    throw new Error(`douzed is already running (pid ${existing.pid}, port ${existing.port})`)
  }

  const token = installToken()
  const store = new CaptureStore(paths.captures)
  const registry = new RecipeRegistry(paths.recipes, paths.fixtures)
  const bridge = new RelayBridge(paths.audit)
  const drift = new DriftWatcher(registry, bridge, paths.recipes, paths.fixtures, {
    // oxlint-disable-next-line unicorn/no-useless-spread -- exactOptionalPropertyTypes forbids an explicit undefined
    ...(process.env['DOUZE_DRIFT_WEBHOOK'] ? { webhook: process.env['DOUZE_DRIFT_WEBHOOK'] } : {}),
  })
  // Awaited: until the watcher is live, a recipe written right after boot would go unnoticed.
  await registry.start()
  drift.schedule()

  // Set once the socket is bound; /pair echoes it back so the extension knows where it landed.
  let bound = 0
  const app = new Hono()

  // AC-EXE-001.1 — every loopback request carries the install token. /pair is the one exception
  // and guards itself on Origin instead, because it is how the token is handed out.
  app.use('*', async (c, next) => {
    if (c.req.path === '/health' || c.req.path === '/pair') return next()
    const provided = c.req.header('x-douze-token') ?? new URL(c.req.url).searchParams.get('token')
    if (provided === token) return next()
    // A reopened tab or a bookmark reaches /review with a link that no longer matches, and a
    // person is looking at it — so it answers as a page, in words that name their next move.
    // Everything else is an API route with a client behind it and keeps its JSON 401.
    if (c.req.path.startsWith('/review/')) {
      const page = await notice(
        'This link has expired.',
        'Click the Douze button in Chrome and record the site again to get a fresh one.',
      )
      return c.html(page, 401)
    }
    return c.json({ error: 'invalid install token' }, 401)
  })

  app.get('/health', (c) => c.json({ ok: true, extension_connected: bridge.connected }))

  /**
   * The extension pairs itself here so nobody has to copy a token out of a terminal.
   *
   * Two checks, and both are the security boundary. The Origin check keeps pages out: a malicious
   * page can open a WebSocket to loopback without CORS, so the install token must never become
   * readable by one — a page cannot forge `Origin: chrome-extension://…`, and without an
   * `Access-Control-Allow-Origin` naming its own origin it cannot read the response either.
   *
   * The pin (#pinnedExtension) then keeps *other extensions* out, because they can send that
   * header honestly. First one to pair wins the install; the rest get 403 and a line on stderr.
   */
  app.on(['GET', 'OPTIONS'], '/pair', (c) => {
    const origin = c.req.header('origin') ?? ''
    const id = extensionIdOf(origin)
    if (!id) return c.json({ error: 'forbidden' }, 403)

    const pinned = pinnedExtension()
    if (pinned && pinned !== id) {
      // Named on stderr because someone hitting this has no other way to find out why the popup
      // says the daemon is unreachable, and the id is the only searchable thing they have.
      process.stderr.write(
        `douzed: refused pairing from extension ${id} — this install is paired with ${pinned}. ` +
          `Delete ${paths.extension} to pair a different extension.\n`,
      )
      return c.json({ error: 'forbidden' }, 403)
    }

    c.header('Access-Control-Allow-Origin', origin)
    c.header('Vary', 'Origin')
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    // Written here and nowhere else: only a request that leaves with the token claims the pin.
    if (!pinned) pinExtension(id)
    return c.json({ token, port: bound, version: DOUZED_VERSION })
  })

  /** AC-RUN-002 — clients poll or subscribe here; the registry is the single source of truth. */
  app.get('/registry', (c) => c.json(registry.state()))

  app.get('/recipes', (c) => c.json(registry.recipes()))

  app.get('/sessions', (c) => c.json(store.sessions()))

  app.get('/sessions/:id', (c) => {
    const id = c.req.param('id')
    const session = store.session(id)
    if (!session) return c.json({ error: `no session ${id}` }, 404)
    return c.json({ session, exchanges: store.exchanges(id), annotations: store.annotations(id) })
  })

  /** REQ-DRF-001 — an on-demand Doctor Run; the scheduled one uses the same path. */
  app.post('/doctor/:recipe', async (c) => {
    try {
      return c.json(await drift.run(c.req.param('recipe')))
    } catch (error) {
      return c.json({ error: 'doctor_failed', message: (error as Error).message }, 400)
    }
  })

  app.post('/import/har', async (c) => {
    const { har, name } = await c.req.json<{ har: unknown; name: string }>()
    return c.json(importHar(store, har, name))
  })

  // REQ-REC-002 — review lives here so approving a tool never needs a terminal. One session per
  // capture, held until douzed exits or the capture behind it grows.
  type Review = import('@douze/studio').StudioSession
  const reviews = new Map<string, { session: Review; exchanges: number }>()

  const review = async (sessionId: string): Promise<Review | null> => {
    const session = store.session(sessionId)
    if (!session) return null
    const exchanges = store.exchanges(sessionId)
    if (exchanges.length === 0) return null

    // The extension buffers exchanges while the socket is down and drains them after reconnect,
    // so a capture can still grow after its review was built — including a stopped one. Caching
    // on count alone rebuilds then, rather than hiding the late arrivals for the daemon's life.
    const cached = reviews.get(sessionId)
    if (cached && cached.exchanges === exchanges.length) return cached.session

    // ADR-006 — the inference engine is loaded here and nowhere else.
    const { StudioSession, baseUrlFrom } = await import('@douze/studio')
    const built = StudioSession.fromExchanges(
      {
        recipeName: session.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
        baseUrl: baseUrlFrom(exchanges),
        paths: { recipes: paths.recipes, fixtures: paths.fixtures },
      },
      { exchanges, annotations: store.annotations(sessionId) },
    )
    reviews.set(sessionId, { session: built, exchanges: exchanges.length })
    return built
  }

  app.get('/review/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    if (!(await review(sessionId))) {
      return c.html(
        await notice(
          'Nothing was recorded yet.',
          'Click the Douze button in Chrome, press Watch this site, use the site for a minute, then press Done.',
        ),
        404,
      )
    }
    const { reviewPage } = await import('@douze/studio')
    // The page carries the token in its URL and inlines it, so its own fetches authenticate.
    return c.html(reviewPage({ id: sessionId, token }))
  })

  app.get('/api/review/:sessionId', async (c) => {
    const session = await review(c.req.param('sessionId'))
    if (!session) return c.json({ error: 'no_session' }, 404)
    return c.json({
      site: hostnameOf(session.config.baseUrl),
      recipe: session.config.recipeName,
      candidates: session.view(),
    })
  })

  app.post('/api/review/:sessionId/enable', async (c) => {
    const session = await review(c.req.param('sessionId'))
    if (!session) return c.json({ error: 'no_session' }, 404)
    // A body-less POST is the bulk path. A body that does not parse is not the same thing: it is
    // a caller that meant to name tools, and running the bulk path for it would enable a set
    // nobody asked for. Only an absent body is silence.
    const raw = (await c.req.text()).trim()
    let names: string[] | undefined
    if (raw !== '') {
      try {
        names = (JSON.parse(raw) as { names?: string[] }).names
      } catch {
        return c.json({ error: 'bad_request', message: 'The request body is not valid JSON.' }, 400)
      }
    }

    // AC-REC-002.3 — with no list this is the bulk path, which reaches `read` candidates only.
    // A write or destructive tool is enabled only when the user named it, one at a time.
    if (!Array.isArray(names)) {
      const bulk = session.approveReads()
      return c.json({ enabled: bulk.approved, skipped: bulk.skipped })
    }
    const enabled: string[] = []
    const skipped: string[] = []
    for (const name of names) {
      if (knows(session, name)) {
        session.approve(name)
        enabled.push(name)
      } else {
        skipped.push(name)
      }
    }
    return c.json({ enabled, skipped })
  })

  app.post('/api/review/:sessionId/disable', async (c) => {
    const session = await review(c.req.param('sessionId'))
    if (!session) return c.json({ error: 'no_session' }, 404)
    const { names } = await c.req.json<{ names?: string[] }>().catch(() => ({}) as { names?: string[] })
    for (const name of names ?? []) if (knows(session, name)) session.unapprove(name)
    return c.json({ ok: true })
  })

  app.post('/api/review/:sessionId/edit', async (c) => {
    const session = await review(c.req.param('sessionId'))
    if (!session) return c.json({ error: 'no_session' }, 404)
    const body = await c.req.json<{ name?: string; field?: import('@douze/studio').EditableField; value?: unknown }>()
    if (!body.name || !body.field) return c.json({ error: 'name and field are required' }, 400)
    try {
      session.edit(body.name, body.field, body.value)
      // AC-REC-002.2 — the edit reaches the recipe immediately, so #RecipeRegistry hot-reloads it
      // without the user remembering to press anything.
      session.save()
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400)
    }
  })

  app.post('/api/review/:sessionId/save', async (c) => {
    const session = await review(c.req.param('sessionId'))
    if (!session) return c.json({ error: 'no_session' }, 404)
    try {
      const report = session.save()
      const tools = session.candidates.filter((x) => x.tool.approved).map((x) => x.tool.name)
      return c.json({ path: report.path, tools })
    } catch (error) {
      return c.json({ error: 'save_failed', message: (error as Error).message }, 400)
    }
  })

  /**
   * What is already set up on the origin the user is looking at — the extension popup's list.
   *
   * The popup reads this cross-origin, so it needs ACAO. Unlike /pair this stays behind the token
   * check, so the header only decides who may *read* an answer the caller already had to
   * authenticate for; a page with no token gets 401 either way.
   */
  app.get('/api/site-tools', (c) => {
    const origin = c.req.header('origin') ?? ''
    if (origin.startsWith('chrome-extension://')) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
    }
    const wanted = originOf(c.req.query('origin') ?? '')
    if (!wanted) return c.json({ tools: [] })
    const tools = registry
      .state()
      .tools.filter((t) => originOf(t.base_url) === wanted)
      .map((t) => ({ name: t.qualified_name, description: t.tool.description, side_effect: t.tool.side_effect }))
    return c.json({ tools })
  })

  /** The relay entry point used by `douze --mcp` and the CLI (AC-EXE-001.1). */
  app.post('/relay/:recipe/:tool', async (c) => {
    const qualified = `${c.req.param('recipe')}_${c.req.param('tool')}`
    const surface = registry.state().tools.find((t) => t.qualified_name === qualified)
    if (!surface) return c.json({ error: 'unknown_tool', message: `no tool "${qualified}"` }, 404)

    const body = await c.req.json<{ args?: Record<string, unknown>; timeout_ms?: number }>()
    try {
      const response = await bridge.call(surface, body.args ?? {}, {
        // oxlint-disable-next-line unicorn/no-useless-spread -- exactOptionalPropertyTypes forbids an explicit undefined
        ...(body.timeout_ms === undefined ? {} : { timeout_ms: body.timeout_ms }),
      })
      return c.json(response)
    } catch (error) {
      if (error instanceof DouzeError) return c.json(error.toResult(), 502)
      return c.json({ error: 'relay_failed', message: (error as Error).message }, 500)
    }
  })

  const server = createServer(async (req, res) => {
    // Defence in depth against DNS rebinding: a page that points its own name at 127.0.0.1 still
    // sends that name as Host. douzed binds loopback only, so no legitimate client sends anything
    // else. Checked here rather than in Hono because this is where the real header is.
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{"error":"forbidden"}')
      return
    }
    const response = await app.fetch(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers as HeadersInit,
        ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: await readBody(req), duplex: 'half' }),
      } as RequestInit),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })

  // ADR-003 — the extension dials in; douzed never dials out to the browser.
  const wss = new WebSocketServer({ server, path: '/ws' })
  // ws re-emits the HTTP server's errors on itself, and an unhandled 'error' on an EventEmitter
  // is an uncaughtException — which would turn a busy port into a crash instead of the fallback
  // below. Report it and let the listen promise decide what to do.
  //
  // A busy port is not news: walking PORT_RANGE means every port before the free one raises
  // EADDRINUSE by design, and printing five lines about handled attempts buries a real fault.
  wss.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return
    process.stderr.write(`douzed: websocket server — ${error.message}\n`)
  })

  wss.on('connection', (socket, req) => {
    // An upgrade never reaches the request handler above, so it repeats the Host check itself.
    const provided = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('token')
    if (provided !== token || !isLoopbackHost(req.headers.host)) {
      socket.close(1008, 'invalid install token')
      return
    }
    bridge.attach(socket)
    socket.send(JSON.stringify({ type: 'welcome', heartbeat_ms: 20_000 }))

    socket.on('message', (raw) => {
      // A throw in a ws listener becomes an uncaughtException and takes the daemon down, and
      // appendExchange throws by design on anything it cannot store — a malformed exchange, or a
      // credential that reached the leak gate unredacted. One refused write must never cost the
      // relay (AC-RUN-003.1). Refuse the message, report it, keep serving.
      //
      // This line is the only trace a refusal leaves, and a detached daemon discards stderr —
      // which is how a site whose every exchange was being refused looked identical to a site
      // that made no requests at all. Worth remembering before trusting a silent capture.
      try {
        const parsed = ClientMessage.safeParse(JSON.parse(String(raw)))
        if (!parsed.success) {
          process.stderr.write(`douzed: dropped malformed extension message\n`)
          return
        }
        handleClientMessage(parsed.data, store, bridge)
      } catch (error) {
        process.stderr.write(`douzed: refused extension message — ${(error as Error).message}\n`)
      }
    })
  })

  // The extension probes PORT_RANGE and nothing else, so douzed must land inside it whenever it
  // can. An explicit port or DOUZE_PORT still wins, and still fails loudly if it is taken; only
  // the default walks, and only reaches an ephemeral port once the whole range is held — at which
  // point the CLI and the connector still find it through douzed.json, but the extension cannot.
  const requested = options.port ?? (process.env['DOUZE_PORT'] ? Number(process.env['DOUZE_PORT']) : undefined)
  let port: number
  try {
    port = requested === undefined ? await listenInRange(server) : await listen(server, requested)
  } catch (cause) {
    // The MCP process hosts this and stays up afterwards, so a daemon that never bound must not
    // leave a file watcher and an open database behind for the life of the client.
    drift.stop()
    await registry.stop()
    store.close()
    throw cause
  }
  bound = port
  writeRuntime({ pid: process.pid, port, started_at: Date.now() })

  return {
    port,
    registry,
    store,
    bridge,
    drift,
    close: async () => {
      drift.stop()
      await registry.stop()
      // Every live socket, terminated by hand. `wss.close()` only stops new upgrades — an
      // already-connected extension keeps its socket, `server.close()` waits for connections that
      // will never end on their own, and the process hangs instead of exiting. `douze stop` then
      // reports success while the daemon it "stopped" holds the port forever.
      for (const client of wss.clients) client.terminate()
      wss.close()
      store.close()
      // `server.close()` waits for every open connection, and an idle keep-alive one from the CLI
      // or a review tab never closes on its own — so shutdown stalls until the client times out.
      server.closeIdleConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function handleClientMessage(message: ClientMessage, store: CaptureStore, bridge: RelayBridge): void {
  switch (message.type) {
    case 'exchange.session.start':
      // The extension owns session identity; douzed adopts its id so the two agree.
      store.startSession({
        id: message.session.id,
        name: message.session.name,
        origins: message.session.origins,
        debugger_enabled: message.session.debugger_enabled,
      })
      return
    case 'exchange.append':
      store.appendExchange(Exchange.parse(message.exchange))
      return
    case 'exchange.annotate':
      store.annotate(message.span.session_id, message.span.note)
      return
    case 'exchange.session.stop':
      store.stopSession(message.session_id)
      return
    case 'relay.response':
      bridge.settle(RelayResponse.parse(message.response))
      return
    default:
      return
  }
}

/** The dead ends a browser can reach. ADR-006 holds: studio is loaded here, never imported. */
const notice = async (headline: string, next: string): Promise<string> => {
  const { noticePage } = await import('@douze/studio')
  return noticePage(headline, next)
}

const knows = (session: import('@douze/studio').StudioSession, name: string): boolean =>
  session.candidates.some((c) => c.tool.name === name)

/** A malformed base_url must not match a malformed query — both become null, never equal. */
const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** The names loopback answers to, with or without a port. Anything else was resolved by a DNS server. */
const isLoopbackHost = (host: string | undefined): boolean =>
  /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host ?? '')

const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

const readBody = (req: import('node:http').IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    // An aborted upload never emits 'end'. Without this the request handler awaits forever and
    // the client is left holding an open connection that will never be answered.
    req.on('error', reject)
  })

/**
 * Walks the range the extension probes, then gives up on being findable rather than on running.
 *
 * A port held by another douzed ends the walk instead of pushing us one along it: two clients
 * starting at the same instant both find nothing, both try 8787, and the loser would otherwise
 * bind 8788 and run a second daemon with its own registry. Losing the bind means the winner is
 * the daemon, and `hostOrAdopt` re-probes and talks to it.
 *
 * ponytail: a 250 ms probe, not a handshake. The winner's HTTP handler is attached before it
 * binds, so it answers as soon as its loop is free; a slower answer falls through to the next
 * port, which is the behaviour we had before. Make it a real handshake only if a duplicate
 * daemon ever shows up in the wild.
 */
const listenInRange = async (server: import('node:http').Server): Promise<number> => {
  for (const candidate of PORT_RANGE) {
    const bound = await listen(server, candidate).catch(() => 0)
    if (bound > 0) return bound
    if (await douzedOn(candidate)) throw new Error(`douzed is already running on port ${candidate}`)
  }
  // Every port in the range is held by something that is not douzed. The daemon still runs, but
  // the extension probes the range and nothing else, so it will never find this one — and that
  // looks exactly like a broken install unless we say so.
  process.stderr.write(
    `douzed: ports ${PORT_RANGE[0]}-${PORT_RANGE.at(-1)} are all held by another process, so the ` +
      `Chrome extension cannot find douzed. Free one of them, or start douzed with DOUZE_PORT set ` +
      `to a port inside that range.\n`,
  )
  return listen(server, 0)
}

/**
 * Whether a *douzed* holds this port, as opposed to anything else that answers /health. RStudio
 * Server defaults to 8787 and 200s on almost any path, and treating that as our own daemon aborted
 * startup with "douzed is already running" on a port douzed had never touched. The body has to
 * name itself, and a redirect is never followed: fetch follows by default, so an unrelated service
 * bouncing /health to a login page that 200s would answer for it.
 */
const douzedOn = async (port: number): Promise<boolean> => {
  try {
    // The timeout is not optional: whatever holds the port may accept the connection and never
    // answer — RStudio Server, a stalled process, a test squatting the range — and an unbounded
    // fetch would hang the daemon's startup on it forever.
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(250),
    })
    if (!res.ok) return false
    const body = (await res.json()) as Record<string, unknown>
    return typeof body === 'object' && body !== null && 'ok' in body && 'extension_connected' in body
  } catch {
    return false
  }
}

const listen = (server: import('node:http').Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    // Removed on success: left attached, this handler would reject an already-settled promise on
    // the first ordinary server error — silently, and long after anyone is listening for it.
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve((server.address() as { port: number }).port)
    })
  })
