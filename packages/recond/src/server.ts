import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { Hono } from 'hono'
import { ClientMessage, Exchange, ReconError, RelayResponse } from '@recon/shared'
import { CaptureStore } from './capture-store.js'
import { RecipeRegistry } from './registry.js'
import { RelayBridge } from './relay.js'
import { ensureHome, installToken, isAlive, readRuntime, writeRuntime } from './paths.js'
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

/**
 * recond — the only always-on Recon process (TR-5, AC-RUN-003.1). It holds the extension
 * WebSocket, the recipe registry, and the capture store. Inference, model calls, and the
 * review UI deliberately live in `recon studio` and are never imported here.
 */
export async function startDaemon(options: { port?: number } = {}): Promise<Daemon> {
  const paths = ensureHome()

  // AC-RUN-003.2 — a live instance means this one exits rather than binding a second port.
  const existing = readRuntime()
  if (isAlive(existing)) {
    throw new Error(`recond is already running (pid ${existing.pid}, port ${existing.port})`)
  }

  const token = installToken()
  const store = new CaptureStore(paths.captures)
  const registry = new RecipeRegistry(paths.recipes, paths.fixtures)
  const bridge = new RelayBridge(paths.audit)
  const drift = new DriftWatcher(registry, bridge, paths.recipes, paths.fixtures, {
    ...(process.env['RECON_DRIFT_WEBHOOK'] ? { webhook: process.env['RECON_DRIFT_WEBHOOK'] } : {}),
  })
  registry.start()
  drift.schedule()

  const app = new Hono()

  // AC-EXE-001.1 — every loopback request carries the install token.
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next()
    const provided = c.req.header('x-recon-token') ?? new URL(c.req.url).searchParams.get('token')
    if (provided !== token) return c.json({ error: 'invalid install token' }, 401)
    return next()
  })

  app.get('/health', (c) => c.json({ ok: true, extension_connected: bridge.connected }))

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

  /** The relay entry point used by `recon --mcp` and the CLI (AC-EXE-001.1). */
  app.post('/relay/:recipe/:tool', async (c) => {
    const qualified = `${c.req.param('recipe')}_${c.req.param('tool')}`
    const surface = registry.state().tools.find((t) => t.qualified_name === qualified)
    if (!surface) return c.json({ error: 'unknown_tool', message: `no tool "${qualified}"` }, 404)

    const body = await c.req.json<{ args?: Record<string, unknown>; timeout_ms?: number }>()
    try {
      const response = await bridge.call(surface, body.args ?? {}, {
        ...(body.timeout_ms === undefined ? {} : { timeout_ms: body.timeout_ms }),
      })
      return c.json(response)
    } catch (error) {
      if (error instanceof ReconError) return c.json(error.toResult(), 502)
      return c.json({ error: 'relay_failed', message: (error as Error).message }, 500)
    }
  })

  const server = createServer(async (req, res) => {
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

  // ADR-003 — the extension dials in; recond never dials out to the browser.
  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (socket, req) => {
    const provided = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('token')
    if (provided !== token) {
      socket.close(1008, 'invalid install token')
      return
    }
    bridge.attach(socket)
    socket.send(JSON.stringify({ type: 'welcome', heartbeat_ms: 20_000 }))

    socket.on('message', (raw) => {
      // A throw in a ws listener becomes an uncaughtException and takes the daemon down. The
      // leak gate in appendExchange throws BY DESIGN, so one refused write must never cost the
      // relay (AC-RUN-003.1). Refuse the message, report it, keep serving.
      try {
        const parsed = ClientMessage.safeParse(JSON.parse(String(raw)))
        if (!parsed.success) {
          process.stderr.write(`recond: dropped malformed extension message\n`)
          return
        }
        handleClientMessage(parsed.data, store, bridge)
      } catch (error) {
        process.stderr.write(`recond: refused extension message — ${(error as Error).message}\n`)
      }
    })
  })

  const port = await listen(server, options.port ?? Number(process.env['RECON_PORT'] ?? 0))
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
      wss.close()
      store.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function handleClientMessage(message: ClientMessage, store: CaptureStore, bridge: RelayBridge): void {
  switch (message.type) {
    case 'exchange.session.start':
      // The extension owns session identity; recond adopts its id so the two agree.
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

const readBody = (req: import('node:http').IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

const listen = (server: import('node:http').Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
