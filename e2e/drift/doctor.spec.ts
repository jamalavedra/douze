import { test, expect, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { FixtureApp, Douzed, REPO, launchHelium, waitFor } from '../harness.js'

/**
 * COV_DRF_001 — a Doctor Run replays fixtures against the LIVE target through the browser relay.
 * Two claims are load-bearing here and both are asserted against the fixture SERVER rather than
 * against the report, because the report is the thing under test and cannot vouch for itself:
 *
 *   AC-DRF-001.1 — only `read` fixtures are ever replayed. A drift check that POSTs or DELETEs
 *                  against a real dashboard is worse than no drift check at all.
 *   AC-DRF-003.1 — a widened response yields a patch adding the field as OPTIONAL, at the depth
 *                  the field actually appeared, with every existing field untouched.
 */

/** `yaml` is a workspace dependency, not a root one; resolve it from the package that owns it. */
const parseYaml = createRequire(join(REPO, 'packages/shared/package.json'))('yaml').parse as (
  source: string,
) => any

/** Fixed by the extension's e2e build, which bakes this exact origin into `host_permissions`. */
const ORIGIN = 'http://127.0.0.1:4180'

/**
 * One recipe carrying all three side effects, each approved and each with a fixture on disk —
 * so the ONLY thing that can keep the write and destructive fixtures off the wire is the
 * read-only gate in #DriftWatcher.
 *
 * `create_order` deliberately shares its path with `list_orders`; the fixture app implements
 * both, so replaying the write would really create an order. That makes the method, not just
 * the path, part of the assertion below.
 */
const MIXED_RECIPE = `
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
  - name: create_order
    description: Creates an order.
    side_effect: write
    confidence: 0.8
    observations: 2
    approved: true
    fixtures: [create_order.json]
    request:
      method: POST
      path: /api/orders
      input_schema:
        type: object
        properties:
          item: { type: string }
          qty: { type: integer }
        required: [item]
  - name: delete_order
    description: Deletes an order permanently.
    side_effect: destructive
    confidence: 0.8
    observations: 2
    approved: true
    fixtures: [delete_order.json]
    request:
      method: DELETE
      path: /api/orders/{orderId}
      input_schema:
        type: object
        properties:
          orderId: { type: integer }
          confirm: { type: boolean }
        required: [orderId, confirm]
`

/**
 * A single read tool whose response contract is spelled out in full, because AC-DRF-003.1 is as
 * much about what the patch does NOT touch as about what it adds.
 */
const SCHEMA_RECIPE = `
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
      output_schema:
        type: object
        properties:
          data:
            type: object
            properties:
              orders:
                type: array
                items:
                  type: object
                  properties:
                    id: { type: integer }
                    item: { type: string }
                    qty: { type: integer }
                    status: { type: string }
                  required: [id, item, qty, status]
          meta:
            type: object
            properties:
              total: { type: integer }
`

/** The recorded response, matching what the fixture app serves before any control flag is set. */
const ORDERS_FIXTURE = '{"data":{"orders":[{"id":1042,"item":"widget","qty":2,"status":"open"}]},"meta":{"total":2}}'

test.describe('COV_DRF_001: Doctor runs', () => {
  let app: FixtureApp
  let douzed: Douzed
  let browser: Awaited<ReturnType<typeof launchHelium>>
  let page: Page

  /**
   * Same shape as COV_EXE_001's boot: a Doctor Run replays THROUGH the relay, so it needs the
   * whole stack — fixture app, daemon, Helium with the extension, and a signed-in tab.
   */
  const boot = async (recipe: string) => {
    app = new FixtureApp()
    await app.start()
    await app.reset()

    douzed = new Douzed()
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), recipe)
    writeFileSync(join(douzed.fixturesDir, 'list_orders.json'), ORDERS_FIXTURE)
    writeFileSync(join(douzed.fixturesDir, 'create_order.json'), '{"data":{"order":{"id":1044}}}')
    writeFileSync(join(douzed.fixturesDir, 'delete_order.json'), '{"data":{"deleted":1042}}')
    await douzed.start()

    browser = await launchHelium()
    await browser.serviceWorker.evaluate(
      ([port, token]) => (globalThis as never as DouzeApi).__douze.connect(Number(port), String(token)),
      [String(douzed.port), douzed.token] as const,
    )

    page = await browser.context.newPage()
    await page.goto(app.origin)
    // Without a session the relay answers 401 and doctor classifies everything `session_expired`,
    // which would make both tests vacuously pass.
    await page.evaluate(() => fetch('/login', { method: 'POST' }).then((r) => r.json()))

    // A replay cannot be forwarded until the extension's socket is up.
    await waitFor(async () => (await (await douzed.api('/health')).json()).extension_connected, 'extension socket')
    // Clears the sign-in POST and the page's own traffic, so what remains is doctor's alone.
    await app.reset()
  }

  const doctor = async (recipe = 'orders') => {
    const res = await douzed.api(`/doctor/${recipe}`, { method: 'POST' })
    return { status: res.status, report: await res.json() }
  }

  test.afterEach(async () => {
    await browser?.dispose()
    await douzed?.stop()
    await app?.stop()
  })

  test('@COV_DRF_001.1 should never replay write or destructive fixtures', async () => {
    await boot(MIXED_RECIPE)

    const { status, report } = await doctor()
    expect(status).toBe(200)

    // AC-DRF-001.1 — the read tool is the only one the run has anything to say about.
    expect(report.tools.map((t: { tool: string }) => t.tool)).toEqual(['list_orders'])

    const log = await app.log()

    // The read fixture WAS replayed — otherwise "nothing was written" would prove nothing.
    expect(log.filter((r) => r.method === 'GET' && r.path === '/api/orders').length).toBeGreaterThan(0)

    // AC-DRF-001.1 — `create_order` shares `/api/orders` with the read tool, so the proof it was
    // not replayed is that no request at that path used its method.
    expect(log.filter((r) => r.path === '/api/orders' && r.method !== 'GET')).toEqual([])

    // AC-DRF-001.1 — `delete_order` has a path of its own; nothing may have touched it.
    expect(log.filter((r) => /^\/api\/orders\/\d+$/.test(r.path))).toEqual([])

    // And nothing anywhere on the target was issued with a mutating method.
    expect(log.filter((r) => r.method !== 'GET')).toEqual([])
  })

  test('@COV_DRF_001.2 should classify an added optional field as schema_widened and propose a patch', async () => {
    await boot(SCHEMA_RECIPE)
    // The upstream change under test: order objects gain an optional `priority`. Set after boot,
    // because boot's final reset() clears every control flag along with the log.
    await app.set('widenResponse', true)

    const before = parseYaml(SCHEMA_RECIPE).tools[0].response.output_schema

    const { report } = await doctor()

    // AC-DRF-001.2 — a field that appeared is a widening, never a break.
    const tool = report.tools.find((t: { tool: string }) => t.tool === 'list_orders')
    expect(tool.status).toBe('schema_widened')
    expect(tool.added_fields).toEqual(['$.data.orders[].priority'])
    expect(report.patched).toBe(true)

    // AC-DRF-003.1 — the patch is on DISK, not in the report. Read the recipe back and compare.
    const patched = parseYaml(readFileSync(join(douzed.recipesDir, 'orders.yaml'), 'utf8'))
    const after = patched.tools[0].response.output_schema
    const items = after.properties.data.properties.orders.items

    // At the correct depth: inside the array's item schema, not at the root.
    expect(items.properties.priority).toEqual({ type: 'string' })
    // Optional by construction — `required` is exactly what it was, with `priority` absent.
    expect(items.required).toEqual(['id', 'item', 'qty', 'status'])

    // ...and nothing else moved: strip the one addition and the schema is byte-for-byte the old one.
    delete items.properties.priority
    expect(after).toEqual(before)
    expect(patched.tools[0].response.primary_payload_path).toBe('$.data.orders')
    // A widening is not a degradation; the tool must stay callable (AC-DRF-002.1 by contrast).
    expect(patched.tools[0].flags?.degraded ?? false).toBe(false)
  })
})

interface DouzeApi {
  __douze: { connect(port: number, token: string): Promise<void> }
}
