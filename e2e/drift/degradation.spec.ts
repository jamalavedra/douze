import { test, expect, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { FixtureApp, Douzed, REPO, launchHelium, waitFor, TSX } from '../harness.js'

/**
 * COV_DRF_002 — REQ-DRF-002 in one run. #DriftWatcher owns no client-facing mechanism of its
 * own: it writes `degraded` into the recipe and lets the ordinary hot-reload path carry it, so
 * the test has to observe all four consequences of that single write:
 *
 *   AC-DRF-002.1 — the recipe on disk is marked, and a CONNECTED client picks it up, no restart.
 *   AC-DRF-002.2 — invoking the degraded tool fails with the tool and the change named...
 *   AC-EXE-003.4 — ...BEFORE a request is issued, which only the target's own log can prove.
 *   AC-DRF-002.3 — a tool whose endpoint did not drift keeps serving.
 */

/** `yaml` is a workspace dependency, not a root one; resolve it from the package that owns it. */
const parseYaml = createRequire(join(REPO, 'packages/shared/package.json'))('yaml').parse as (
  source: string,
) => any

/** Fixed by the extension's e2e build, which bakes this exact origin into `host_permissions`. */
const ORIGIN = 'http://127.0.0.1:4180'

/**
 * Two approved read tools on two different endpoints. `breakResponse` drops the required
 * `status` field from order objects only, so `/api/poll` is untouched — which is exactly the
 * isolation AC-DRF-002.3 asks for: one endpoint drifts, the other does not.
 */
const RECIPE = `
version: 1
name: orders
enabled: true
target:
  base_url: ${ORIGIN}
auth:
  mode: browser_relay
  credential_source:
    - kind: cookie
tools:
  - name: list_orders
    description: Lists every order.
    side_effect: read
    confidence: 0.9
    observations: 3
    approved: true
    fixtures: [list_orders.json]
    request:
      method: GET
      path: /api/orders
    response:
      primary_payload_path: $.data.orders
  - name: poll_status
    description: Reports the current server tick.
    side_effect: read
    confidence: 0.9
    observations: 3
    approved: true
    fixtures: [poll_status.json]
    request:
      method: GET
      path: /api/poll
    response:
      primary_payload_path: $.data
`

/** The recorded responses. `list_orders` records `status`, the field the target will stop sending. */
const ORDERS_FIXTURE = '{"data":{"orders":[{"id":1042,"item":"widget","qty":2,"status":"open"}]},"meta":{"total":2}}'
const POLL_FIXTURE = '{"data":{"tick":1}}'

/** A minimal JSON-RPC-over-stdio client, so the assertion is on the wire, not on an abstraction. */
class McpClient {
  private readonly child: ChildProcess
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, (value: unknown) => void>()
  readonly notifications: string[] = []

  constructor(home: string) {
    this.child = spawn(TSX, [join(REPO, 'packages/cli/src/bin.ts'), '--mcp'], {
      env: { ...process.env, DOUZE_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout!.on('data', (chunk) => {
      this.buffer += String(chunk)
      for (const line of this.buffer.split('\n').slice(0, -1)) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown }
        if (message.method) this.notifications.push(message.method)
        else if (message.id !== undefined) this.pending.get(message.id)?.(message.result)
      }
      this.buffer = this.buffer.slice(this.buffer.lastIndexOf('\n') + 1)
    })
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
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
      clientInfo: { name: 'e2e', version: '1.0.0' },
    })
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  }

  /** The description is where a degraded tool announces itself to a client (AC-RUN-001.5). */
  async describe(name: string): Promise<string | undefined> {
    const listed = await this.request('tools/list')
    return listed.tools.find((t: { name: string }) => t.name === name)?.description
  }

  kill(): void {
    this.child.kill()
  }
}

test.describe('COV_DRF_002: Degradation propagation', () => {
  let app: FixtureApp
  let douzed: Douzed
  let browser: Awaited<ReturnType<typeof launchHelium>>
  let page: Page
  let client: McpClient

  test.beforeEach(async () => {
    app = new FixtureApp()
    await app.start()
    await app.reset()

    douzed = new Douzed()
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), RECIPE)
    writeFileSync(join(douzed.fixturesDir, 'list_orders.json'), ORDERS_FIXTURE)
    writeFileSync(join(douzed.fixturesDir, 'poll_status.json'), POLL_FIXTURE)
    await douzed.start()

    // A Doctor Run replays THROUGH the relay, so the whole stack has to be live.
    browser = await launchHelium()
    await browser.serviceWorker.evaluate(
      ([port, token]) => (globalThis as never as DouzeApi).__douze.connect(Number(port), String(token)),
      [String(douzed.port), douzed.token] as const,
    )

    page = await browser.context.newPage()
    await page.goto(app.origin)
    // Without a session every replay comes back 401 and doctor reports `session_expired`, which
    // is not the classification under test.
    await page.evaluate(() => fetch('/login', { method: 'POST' }).then((r) => r.json()))

    await waitFor(async () => (await (await douzed.api('/health')).json()).extension_connected, 'extension socket')
    await app.reset()
  })

  test.afterEach(async () => {
    client?.kill()
    await browser?.dispose()
    await douzed?.stop()
    await app?.stop()
  })

  const relay = async (tool: string) => {
    const res = await douzed.api(`/relay/orders/${tool}`, { method: 'POST', body: JSON.stringify({ args: {} }) })
    return { status: res.status, body: await res.json() }
  }

  /** Requests the target actually saw at a path — the only witness for "issued nothing". */
  const hits = async (path: string) => (await app.log()).filter((r) => r.path === path).length

  test('@COV_DRF_002.1 should degrade a tool through hot reload while healthy tools continue', async () => {
    // The upstream change: order objects stop carrying the required `status` field. Set after
    // beforeEach's reset(), which clears every control flag along with the log.
    await app.set('breakResponse', true)

    // The client connects BEFORE the run. AC-DRF-002.1 is about a client that never restarted,
    // so it has to have been listening the whole time.
    client = new McpClient(douzed.home)
    await client.initialize()
    expect(await client.describe('orders_list_orders')).toBe('Lists every order.')
    const notificationsBefore = client.notifications.length

    const report = await (await douzed.api('/doctor/orders', { method: 'POST' })).json()

    // AC-DRF-001.2 — the drifted tool is `breaking`; the untouched endpoint is `ok`.
    expect(report.tools).toEqual([
      { tool: 'list_orders', status: 'breaking', detail: 'missing $.data.orders[].status' },
      { tool: 'poll_status', status: 'ok' },
    ])
    expect(report.patched).toBe(true)

    // (a) AC-DRF-002.1 — the degradation lives in the recipe file, not in daemon memory.
    const recipe = parseYaml(readFileSync(join(douzed.recipesDir, 'orders.yaml'), 'utf8'))
    const degraded = recipe.tools.find((t: { name: string }) => t.name === 'list_orders')
    const healthy = recipe.tools.find((t: { name: string }) => t.name === 'poll_status')
    expect(degraded.flags.degraded).toBe(true)
    expect(degraded.flags.degraded_reason).toContain('$.data.orders[].status')
    expect(healthy.flags.degraded).toBe(false)

    // (b) AC-DRF-002.1 — the still-connected client sees it, by hot reload alone.
    await expect
      .poll(() => client.describe('orders_list_orders'), { timeout: 30_000, intervals: [250] })
      .toContain('Currently degraded and will refuse to run')
    expect(await client.describe('orders_list_orders')).toContain('$.data.orders[].status')
    expect(client.notifications.length).toBeGreaterThan(notificationsBefore)
    expect(client.notifications).toContain('notifications/tools/list_changed')
    // AC-DRF-002.3 — the healthy tool's description was not touched by any of this.
    expect(await client.describe('orders_poll_status')).toBe('Reports the current server tick.')

    // (c) AC-DRF-002.2 / AC-EXE-003.4 — the refusal happens before a request is issued.
    const ordersBefore = await hits('/api/orders')
    const refused = await relay('list_orders')
    expect(refused.body.error).toBe('tool_degraded')
    // The prose names the tool and the site, for whoever Claude reads it out to; the change the
    // Doctor Run detected travels in the detail, where a person is not made to read a JSONPath.
    expect(refused.body.message).toContain('orders_list_orders')
    expect(refused.body.message).toContain('127.0.0.1:4180')
    expect(refused.body.change).toContain('$.data.orders[].status')
    expect(await hits('/api/orders')).toBe(ordersBefore)

    // (d) AC-DRF-002.3 — the unaffected tool still runs, and returns real data.
    const served = await relay('poll_status')
    expect(served.body.ok).toBe(true)
    expect(served.body.status).toBe(200)
    expect(served.body.body.data.tick).toEqual(expect.any(Number))
  })
})

interface DouzeApi {
  __douze: { connect(port: number, token: string): Promise<void> }
}
