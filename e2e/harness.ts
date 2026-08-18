import { chromium, type BrowserContext, type Worker } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * WO-015 T-015.14 — the harness for an extension with no daemon anywhere.
 *
 * What survived T-015.13: `launchHelium`, `FixtureApp`, `McpClient` and `waitFor`. What is new is
 * everything that used to be `Douzed`: the two pipes the extension attaches to (`RelayServer`,
 * `spawnBridge`), the two clients that drive them (`HttpMcp` for streamable HTTP, `McpClient` for
 * stdio), a host that speaks the attachment protocol and lies (`FakeHost`), and the few pokes a
 * spec needs to put state into the extension (`seedRecipe`, `pairRelay`, `redial`).
 *
 * Both pipes are spawned as real processes rather than imported: e2e is not a workspace package,
 * so it cannot resolve `@douze/relay` or `@douze/bridge`, and a spec that imported `startRelay`
 * would be testing a function rather than the thing a user runs.
 *
 * Everything started here registers its own teardown (`stopEverything`, which every spec runs from
 * `afterEach`) rather than relying on a `finally` in the test body, which a Playwright timeout
 * skips entirely.
 */

declare global {
  /**
   * The extension APIs the suite touches inside `evaluate` callbacks. `@types/chrome` belongs to
   * the extension package, not to the root, so the two or three members used here are declared
   * rather than depended on.
   */
  const chrome: {
    storage: {
      local: {
        set: (items: Record<string, unknown>) => Promise<void>
        get: (keys?: string[] | null) => Promise<Record<string, unknown>>
        remove: (keys: string[]) => Promise<void>
      }
    }
    runtime: { sendMessage: (message: unknown) => Promise<unknown> }
    permissions: { contains: (query: { origins: string[] }) => Promise<boolean> }
  }
  /** The extension's own e2e surface (packages/extension/src/background.ts, "e2e surface"). */
  const __douze: {
    startSession: (name: string, origins: string[], opts?: { tabId?: number }) => Promise<string>
    stopSession: () => Promise<{ retained: number }>
    annotate: (note: string) => Promise<void>
    badgeCount: () => number
    recorded: (sessionId: string) => Promise<{ exchanges: unknown[]; annotations: unknown[] }>
    hasOrigin: (origin: string) => Promise<boolean>
    attached: () => Promise<boolean>
    calls: (limit?: number) => Promise<{ tool: string; trust: string; outcome: string }[]>
  }
}
export const REPO = resolve(import.meta.dirname, '..')
export const HELIUM = '/Applications/Helium.app/Contents/MacOS/Helium'
export const EXTENSION = join(REPO, 'packages/extension/dist')
/** Resolved once: `npx` re-resolves on every spawn, which is seconds under a loaded suite. */
export const TSX = join(REPO, 'node_modules/.bin/tsx')

/**
 * Launches Helium with the unpacked Douze extension. Chromium 136+ (and Helium, which carries
 * the same guard) refuses remote debugging against the default profile, so every run gets a
 * scratch --user-data-dir. That also keeps the user's real session untouched.
 */
/**
 * The live-target suite needs a session that survives between runs, because signing in to a real
 * dashboard is a manual act. `DOUZE_E2E_PROFILE` points at a profile the user signs into once;
 * everything else gets a throwaway directory.
 */
export const LIVE_PROFILE = process.env['DOUZE_E2E_PROFILE'] ?? join(tmpdir(), 'douze-live-profile')

// --- teardown ---------------------------------------------------------------

/**
 * Every teardown a spec still owes. Playwright abandons the test body on TIMEOUT, so a `finally`
 * there never runs: the fixture app, the relay and the bridge outlive the run, and the next run
 * dies on its "port is free" wait. `afterEach` runs whether the body finished, failed or timed
 * out — so teardown lives here and a spec registers instead of cleaning up.
 */
const outstanding = new Set<() => Promise<void>>()

/** Registers `run`, handing back a wrapper that runs it once whichever side gets there first. */
function onTeardown(run: () => Promise<void>): () => Promise<void> {
  const once = async (): Promise<void> => {
    if (!outstanding.delete(once)) return
    await run()
  }
  outstanding.add(once)
  return once
}

/**
 * Tears down everything still outstanding, newest first. Every spec calls this from `afterEach`.
 * Best-effort: one teardown that throws must not strand the ones behind it.
 */
export async function stopEverything(): Promise<void> {
  for (const teardown of [...outstanding].reverse()) {
    try {
      await teardown()
    } catch {
      // A failed teardown is not worth failing a passing test over; the rest still have to run.
    }
  }
}

/** A scratch directory, removed by the same teardown as everything else. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  onTeardown(async () => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export interface Spawned {
  child: ChildProcess
  /** Kills the process GROUP and waits for it to be gone. Idempotent. */
  stop: () => Promise<void>
}

/**
 * Spawns a repo script under `tsx`, in a process GROUP of its own, with its teardown registered.
 *
 * `detached` is the load-bearing flag: `tsx` runs the script in a child process of its own, so
 * `child.kill()` reaps the wrapper and orphans the process actually holding the port. A detached
 * child leads a group, and `process.kill(-pid)` takes the whole group with it.
 */
export function spawnTsx(script: string, env: Record<string, string>, stdio: StdioOptions): Spawned {
  const child = spawn(TSX, [join(REPO, script)], { env: { ...process.env, ...env }, stdio, detached: true })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const signal = (name: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, name)
    } catch {
      // The group is already gone, which is the state this wanted anyway.
    }
  }
  const stop = onTeardown(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    signal('SIGTERM')
    // A group that ignores SIGTERM would otherwise hang teardown for the rest of the run.
    const escalate = setTimeout(() => signal('SIGKILL'), 2_000)
    await exited
    clearTimeout(escalate)
  })
  return { child, stop }
}

export interface Browser {
  context: BrowserContext
  serviceWorker: Worker
  extensionId: string
  dispose: () => Promise<void>
}

export async function launchHelium(extensionPath = EXTENSION, options: { profileDir?: string } = {}): Promise<Browser> {
  const persistent = options.profileDir !== undefined
  const userDataDir = options.profileDir ?? mkdtempSync(join(tmpdir(), 'douze-helium-'))
  mkdirSync(userDataDir, { recursive: true })
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: HELIUM,
    // MV3 service workers do not run under old headless.
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  let [serviceWorker] = context.serviceWorkers()
  serviceWorker ??= await context.waitForEvent('serviceworker', { timeout: 20_000 })

  return {
    context,
    serviceWorker,
    extensionId: new URL(serviceWorker.url()).host,
    // Registered, so a spec that closes the browser mid-run (relay.spec.ts) is not closed twice
    // and one abandoned on a timeout is closed anyway.
    dispose: onTeardown(async () => {
      await context.close()
      // A persistent profile holds a real signed-in session; never delete it.
      if (!persistent) rmSync(userDataDir, { recursive: true, force: true })
    }),
  }
}

/** A server-initiated message. `params` carries progress, which COV_CON_003 asserts on. */
export interface Notification {
  method: string
  params?: { progressToken?: string | number; progress?: number; message?: string }
}

/**
 * A minimal JSON-RPC-over-stdio MCP client, so connector assertions are on the wire rather than
 * on an abstraction that could hide the handshake.
 */
export class McpClient {
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, (value: RpcBody) => void>()
  readonly notifications: Notification[] = []

  constructor(readonly child: ChildProcess) {
    this.child.stdout!.on('data', (chunk) => {
      this.buffer += String(chunk)
      for (const line of this.buffer.split('\n').slice(0, -1)) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as { id?: number } & RpcBody & Notification
        if (message.method) this.notifications.push(message)
        else if (message.id !== undefined) this.pending.get(message.id)?.(message)
      }
      this.buffer = this.buffer.slice(this.buffer.lastIndexOf('\n') + 1)
    })
  }

  /** The methods seen, for a spec that only cares that a kind of notification arrived. */
  get notified(): string[] {
    return this.notifications.map((n) => n.method)
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- a JSON-RPC result is whatever the method returns
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.answer(method, params).then((message) => message.result)
  }

  /**
   * The whole JSON-RPC answer. A refusal travels in `error`, so a spec asserting that a guard
   * fired needs this rather than `request`, which would hand it an undefined `result` either way.
   */
  answer(method: string, params: Record<string, unknown> = {}): Promise<RpcBody> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      clientInfo: { name: 'e2e-connector', version: '1.0.0' },
    })
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  }

  /** Recipe tool names; the dispatchers ride on every surface. See LIST_SKILLS in guards.ts. */
  async tools(): Promise<string[]> {
    return ((await this.request('tools/list')).tools as { name: string }[])
      .map((t) => t.name)
      .filter((name) => !DISPATCHERS.includes(name))
  }

  /** The description is where a degraded tool announces itself to a client (AC-RUN-001.5). */
  async describe(name: string): Promise<string | undefined> {
    const listed = (await this.request('tools/list')).tools as { name: string; description: string }[]
    return listed.find((t) => t.name === name)?.description
  }
}

/**
 * The origin the fixture app serves and the one `global-setup.ts` bakes into `host_permissions`.
 * One constant for both: a build that granted an origin the app is not on grants nothing at all.
 */
export const FIXTURE_ORIGIN = process.env['DOUZE_FIXTURE_ORIGIN'] ?? 'http://127.0.0.1:4180'

/** The fixture target app. Every spec asserts against what this server actually received. */
export class FixtureApp {
  private server: Spawned | undefined

  constructor(readonly port = Number(new URL(FIXTURE_ORIGIN).port)) {}

  get origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /**
   * The port is fixed because the extension's e2e build bakes this exact origin into
   * `host_permissions`. That makes start/stop ordering load-bearing: if a previous instance
   * still holds the port, the new one fails to bind and specs silently talk to the old server
   * with the old control-flag state. So: wait for the port to be free, then for OUR server.
   */
  async start(): Promise<void> {
    await waitFor(async () => !(await this.responding()), `port ${this.port} to be free`)
    this.server = spawnTsx('fixtures/server.ts', { FIXTURE_PORT: String(this.port) }, 'ignore')
    await waitFor(() => this.responding(), 'fixture app')
  }

  private async responding(): Promise<boolean> {
    try {
      return (await fetch(`${this.origin}/__test/log`)).ok
    } catch {
      return false
    }
  }

  /** Requests the app saw. The basis for "zero requests were issued" assertions. */
  async log(): Promise<{ method: string; path: string; headers: Record<string, string> }[]> {
    return (await fetch(`${this.origin}/__test/log`)).json()
  }

  async reset(): Promise<void> {
    await fetch(`${this.origin}/__test/reset`)
  }

  /** Flip a control: sessionValid, widenResponse, breakResponse, delayMs, pageStateAuth. */
  async set(key: string, value: unknown): Promise<void> {
    await fetch(`${this.origin}/__test/${key}?value=${encodeURIComponent(JSON.stringify(value))}`)
  }

  /** Awaited, so the next spec's start() cannot race a process still holding the port. */
  async stop(): Promise<void> {
    await this.server?.stop()
    this.server = undefined
  }
}

// --- the two pipes ---------------------------------------------------------

/**
 * The cloud pipe, as the process an operator runs (`packages/relay/src/bin.ts`). The extension
 * dials `ws://127.0.0.1:<port>/ws`; a hosted connector POSTs JSON-RPC to `/m/<secret>`.
 */
export class RelayServer {
  private server: Spawned | undefined

  /** 4190 is on both `fetch`'s and Chrome's blocked-port lists (ManageSieve), so: not that one. */
  constructor(readonly port = 4290) {}

  get origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    await waitFor(async () => !(await this.responding()), `relay port ${this.port} to be free`)
    this.server = spawnTsx('packages/relay/src/bin.ts', { RELAY_PORT: String(this.port) }, ['ignore', 'ignore', 'pipe'])
    this.server.child.stderr!.on('data', (chunk) => (this.events += String(chunk)))
    await waitFor(() => this.responding(), `relay on ${this.port}`)
  }

  private events = ''

  /**
   * The relay's own event log. It carries no payload and no tool name (see `log` in
   * packages/relay/src/server.ts), but it does say when an extension detached and when a call was
   * parked waiting for one — which is how a spec proves it exercised the wake grace rather than
   * racing a socket that never went away.
   */
  log(): string {
    return this.events
  }

  /**
   * Mints an endpoint. This is the half of T-015.10 the connect page's "share with a hosted
   * assistant" button will do before it writes the pairing into extension storage; the button is
   * the same route the connect page's button calls; `pairRelay` writes the key directly so a spec
   * does not have to drive the page to get an endpoint.
   */
  async register(): Promise<{ token: string; mcp_path: string }> {
    const response = await fetch(`${this.origin}/register`, {
      method: 'POST',
      body: JSON.stringify({ daemon_version: 'e2e' }),
    })
    return response.json() as Promise<{ token: string; mcp_path: string }>
  }

  private async responding(): Promise<boolean> {
    try {
      return (await fetch(`${this.origin}/health`)).ok
    } catch {
      return false
    }
  }

  async stop(): Promise<void> {
    await this.server?.stop()
    this.server = undefined
  }
}

/**
 * The local pipe, spawned exactly as an MCP client spawns it. `DOUZE_HOME` redirects the pairing
 * credential (packages/bridge/src/pairing.ts) so a run never reads or writes the user's own.
 */
export function spawnBridge(home: string): { child: ChildProcess; log: () => string } {
  const { child } = spawnTsx('packages/bridge/src/bin.ts', { DOUZE_HOME: home }, ['pipe', 'pipe', 'pipe'])
  let log = ''
  child.stderr!.on('data', (chunk) => (log += String(chunk)))
  return { child, log: () => log }
}

/** The code the bridge printed to stderr for a human to type into the extension. */
export const pairingCode = (log: string): string | null => /Pairing code: ([\dA-Z-]+)/.exec(log)?.[1] ?? null

// --- the clients -----------------------------------------------------------

/**
 * A hosted connector: plain streamable-HTTP MCP over `fetch`, which is the entire compatibility
 * contract ChatGPT, claude.ai and Dust hold Douze to. Deliberately not the MCP SDK — an SDK that
 * papers over a missing header would hide the thing this is here to prove.
 */
/** The two constant tool names. e2e imports nothing from packages, so this is its own copy. */
export const DISPATCHERS = ['douze_list_skills', 'douze_run_skill']

export class HttpMcp {
  private session = ''
  private nextId = 1

  constructor(readonly url: string) {}

  async rpc(method: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: RpcBody }> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.session === '' ? {} : { 'mcp-session-id': this.session }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    })
    const assigned = response.headers.get('mcp-session-id')
    if (assigned) this.session = assigned
    return { status: response.status, body: (await response.json()) as RpcBody }
  }

  async initialize(): Promise<RpcBody> {
    const { body } = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      clientInfo: { name: 'e2e-hosted-connector', version: '1.0.0' },
    })
    return body
  }

  /** Recipe tool names; `allTools` includes the dispatchers. See LIST_SKILLS in guards.ts. */
  async tools(): Promise<string[]> {
    return (await this.allTools()).filter((name) => !DISPATCHERS.includes(name))
  }

  async allTools(): Promise<string[]> {
    const { body } = await this.rpc('tools/list')
    return ((body.result?.['tools'] as { name: string }[] | undefined) ?? []).map((tool) => tool.name)
  }

  call(name: string, args: Record<string, unknown> = {}): Promise<{ status: number; body: RpcBody }> {
    return this.rpc('tools/call', { name, arguments: args })
  }
}

export interface RpcBody {
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: { error?: string; retryable?: boolean } }
}

/** The text an MCP tool result carries, parsed. `null` when the call failed. */
export const resultText = (body: RpcBody): string =>
  ((body.result?.['content'] as { text?: string }[] | undefined) ?? []).map((part) => part.text ?? '').join('')

// --- a host that lies ------------------------------------------------------

export interface AttachedTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  side_effect: 'read' | 'write' | 'destructive'
}

export interface ToolOutcome {
  result?: { content?: { text?: string }[] }
  error?: { code: string; message: string; retryable: boolean }
}

/**
 * A host speaking the attachment protocol — including the frames an honest one never sends.
 *
 * `@douze/mcp-host` refuses a `tools/call` for a tool it never listed, so neither the relay nor
 * the bridge can be used to prove that the EXTENSION refuses it as well. That second half of the
 * trust table is exactly what `checkPolicy` exists for ("a host that lies about what it was sent
 * must not get through", packages/extension/src/guards.ts), and this is the liar that tests it.
 */
export class FakeHost {
  private server?: WebSocketServer
  private socket: WebSocket | null = null
  private heartbeat?: ReturnType<typeof setInterval>
  private nextId = 1
  private readonly pending = new Map<string, (outcome: ToolOutcome) => void>()
  /** Every `surface.push` seen, in order: the offer-time filter is asserted against these. */
  readonly surfaces: AttachedTool[][] = []

  constructor(readonly port = 4191) {}

  /** What goes in `attach:relay`; the extension turns it into `ws://…/ws`. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get attached(): boolean {
    return this.socket?.readyState === 1
  }

  /** The tools this host was last offered. */
  get tools(): AttachedTool[] {
    return this.surfaces.at(-1) ?? []
  }

  async start(): Promise<void> {
    const server = new WebSocketServer({ port: this.port, host: '127.0.0.1', path: '/ws' })
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve())
      // Without this the bind failure surfaces as an unhandled 'error' event and the spec dies on
      // an unrelated timeout instead. A busy 4191 means a previous run's host is still holding it.
      server.once('error', (cause) =>
        reject(new Error(`FakeHost could not bind 127.0.0.1:${this.port} — is a previous run still holding it?`, { cause })),
      )
    })
    server.on('connection', (socket) => {
      socket.on('error', () => socket.terminate())
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null
      })
      socket.on('message', (raw) => this.onFrame(socket, String(raw)))
    })
    // The extension closes a socket that has been silent for 2.5 heartbeats; a spec that spends a
    // minute between calls would otherwise watch it drop for reasons that are not the test's.
    this.heartbeat = setInterval(() => this.socket?.send(JSON.stringify({ type: 'ping' })), 10_000)
    this.heartbeat.unref()
    this.server = server
    this.teardown = onTeardown(() => this.shutdown())
  }

  private onFrame(socket: WebSocket, raw: string): void {
    const frame = JSON.parse(raw) as { type: string; tools?: AttachedTool[]; id?: string } & ToolOutcome
    if (frame.type === 'hello') {
      this.socket = socket
      socket.send(JSON.stringify({ type: 'welcome', heartbeat_ms: 20_000 }))
      return
    }
    if (frame.type === 'surface.push') {
      this.surfaces.push(frame.tools ?? [])
      return
    }
    if (frame.type !== 'tool.result' || frame.id === undefined) return
    const waiter = this.pending.get(frame.id)
    this.pending.delete(frame.id)
    waiter?.({ ...(frame.result === undefined ? {} : { result: frame.result }), ...(frame.error === undefined ? {} : { error: frame.error }) })
  }

  /**
   * One `tool.call`, whether or not the extension ever offered this host that tool.
   *
   * Bounded, because the two ways this goes wrong are silent: nothing attached, so the frame goes
   * nowhere, or the extension dropping the call — either of which used to hang until Playwright's
   * own timeout killed the spec with no idea which call it was on.
   */
  call(name: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<ToolOutcome> {
    const id = `fake-${this.nextId++}`
    return new Promise((resolve, reject) => {
      if (this.socket === null) {
        reject(new Error(`FakeHost.call(${name}): nothing is attached to this host`))
        return
      }
      const expired = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`FakeHost.call(${name}): no tool.result within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, (outcome) => {
        clearTimeout(expired)
        resolve(outcome)
      })
      this.socket.send(JSON.stringify({ type: 'tool.call', id, name, args, trust: 'remote' }))
    })
  }

  /** Idempotent: `stopEverything` may well have got here first. */
  async close(): Promise<void> {
    await this.teardown?.()
  }

  private teardown?: () => Promise<void>

  private async shutdown(): Promise<void> {
    clearInterval(this.heartbeat)
    for (const client of this.server?.clients ?? []) client.terminate()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

// --- putting state into the extension --------------------------------------

export interface RelayPairing {
  url: string
  token: string
  mcp_path: string
  allow_writes: boolean
}

/**
 * Waits for the worker to have finished booting, which is a barrier a spec writing into extension
 * storage has to hold: `RecipeStore.open()` reads storage and only *then* installs the
 * `storage.onChanged` listener, so a write that lands in between is read by neither and the
 * surface stays empty until something else changes it. `__douze.attached()` awaits the worker's
 * own `dialled`, which resolves after the store is open — so it is exactly that barrier.
 *
 * A user never hits this: their first recipe is written by the review page, minutes after boot.
 */
export const ready = (browser: Browser): Promise<void> =>
  waitFor(
    () => browser.serviceWorker.evaluate(() => __douze.attached().then(() => true)),
    'the service worker to finish booting',
  )

/**
 * Recipes as they exist after a review: `recipe:<name>` YAML plus a `fixture:` key per approved
 * tool, which is where `RecipeStore` reads them from (packages/extension/src/recipes.ts). The
 * journey spec earns its recipe the long way; every other spec seeds one, because re-recording
 * per assertion buys nothing and costs a minute.
 */
export async function seedRecipe(browser: Browser, name: string, yaml: string, tools: string[]): Promise<void> {
  await ready(browser)
  await browser.serviceWorker.evaluate(
    (seed) => {
      const items: Record<string, unknown> = { [`recipe:${seed.name}`]: seed.yaml }
      for (const tool of seed.tools) {
        items[`fixture:${seed.name}/${tool}.json`] = { tool, response: { status: 200, body: {} } }
      }
      return chrome.storage.local.set(items)
    },
    { name, yaml, tools },
  )
}

/** The fixture app as one recipe: one read, one write, one destructive. */
export const ordersRecipe = (origin: string): string => `version: 1
name: orders
target:
  base_url: ${origin}
tools:
  - name: list_orders
    description: List the open orders.
    side_effect: read
    confidence: 0.9
    observations: 3
    approved: true
    request:
      method: GET
      path: /api/orders
    response:
      primary_payload_path: $.data.orders
    fixtures: [orders/list_orders.json]
  - name: create_order
    description: Create an order.
    side_effect: write
    confidence: 0.9
    observations: 2
    approved: true
    request:
      method: POST
      path: /api/orders
      input_schema:
        type: object
        properties:
          item: { type: string }
          qty: { type: number }
          note: { type: string }
    response:
      primary_payload_path: $.data.order
    fixtures: [orders/create_order.json]
  - name: delete_order
    description: Delete an order for good.
    side_effect: destructive
    confidence: 0.9
    observations: 1
    approved: true
    request:
      method: DELETE
      path: /api/orders/{id}
      input_schema:
        type: object
        properties:
          id: { type: number }
          confirm: { type: boolean }
        required: [confirm]
    fixtures: [orders/delete_order.json]
`

/** Writes the pairing the connect page will write, then makes the worker dial it. */
export async function pairRelay(browser: Browser, pairing: RelayPairing): Promise<void> {
  await browser.serviceWorker.evaluate((value) => chrome.storage.local.set({ 'attach:relay': value }), pairing)
  await redial(browser)
}

/**
 * Makes the attachment manager re-read its pairings and dial **now**.
 *
 * Its own trigger is a `chrome.alarms` tick with a 30-second floor, which every spec would
 * otherwise pay per attachment. `douze:connect:pair` is the one command that ticks it on demand
 * (packages/extension/src/attach.ts, `Manager.pair`), and an empty code means "no bridge to dial"
 * — so passing one is a tick, and passing a real code is the pairing itself.
 */
export async function redial(browser: Browser, code = ''): Promise<void> {
  const page = await browser.context.newPage()
  await page.goto(`chrome-extension://${browser.extensionId}/connect.html`)
  await page.evaluate((value) => chrome.runtime.sendMessage({ type: 'douze:connect:pair', code: value }), code)
  await page.close()
}

/** T-015.9 — exempt one tool's results from the secret gate, or put them back under it. */
export async function expose(
  browser: Browser,
  trust: 'local' | 'remote',
  tool: string,
  allow: boolean,
): Promise<void> {
  const page = await browser.context.newPage()
  await page.goto(`chrome-extension://${browser.extensionId}/connect.html`)
  await page.evaluate(
    (value) => chrome.runtime.sendMessage({ type: 'douze:connect:expose', ...value }),
    { trust, tool, allow },
  )
  await page.close()
}

/** Signs the browser into the fixture app, so an executed call carries a real session cookie. */
export async function signIn(browser: Browser, app: FixtureApp): Promise<void> {
  const page = await browser.context.newPage()
  await page.goto(app.origin)
  await page.evaluate(() => fetch('/login', { method: 'POST' }).then((response) => response.json()))
  // The app issues a session cookie, which Chrome drops on exit. relay.spec.ts closes the browser
  // mid-run and the same session has to be there when it comes back, so the value the server just
  // issued is re-set with a lifetime — same name, same path, same value.
  await page.evaluate(() => {
    const value = /fixture_session=([^;]+)/.exec(document.cookie)?.[1] ?? ''
    document.cookie = `fixture_session=${value}; path=/; max-age=3600`
  })
  await page.close()
}

export async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}
