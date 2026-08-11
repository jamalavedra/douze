import { test, expect, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FixtureApp, Douzed, launchHelium, waitFor } from '../harness.js'

/**
 * COV_EXE_001 / COV_EXE_002 — the claim the whole product rests on: a tool call runs inside the
 * signed-in browser, carrying the real session, with no credential ever stored. Every assertion
 * is against what the fixture SERVER saw, because that is the only witness that cannot lie.
 */
const cookieRecipe = (origin: string) => `
version: 1
name: orders
enabled: true
target:
  base_url: ${origin}
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
`

const pageStateRecipe = (origin: string) => `
version: 1
name: orders
enabled: true
target:
  base_url: ${origin}
auth:
  mode: browser_relay
  credential_source:
    - kind: page_state
      expression: window.__token
      header: authorization
      prefix: 'Bearer '
    - kind: page_state
      expression: localStorage.getItem('csrf')
      header: x-csrf-token
      prefix: ''
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
`

test.describe('COV_EXE_001: Browser relay', () => {
  let app: FixtureApp
  let douzed: Douzed
  let browser: Awaited<ReturnType<typeof launchHelium>>
  let page: Page

  const boot = async (recipe: string, pageStateAuth: boolean) => {
    app = new FixtureApp()
    await app.start()
    await app.reset()
    if (pageStateAuth) await app.set('pageStateAuth', true)

    douzed = new Douzed()
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), recipe)
    writeFileSync(join(douzed.fixturesDir, 'list_orders.json'), '{"data":{"orders":[]}}')
    await douzed.start()

    browser = await launchHelium()
    await browser.serviceWorker.evaluate(
      ([port, token]) => (globalThis as never as DouzeApi).__douze.connect(Number(port), String(token)),
      [String(douzed.port), douzed.token] as const,
    )

    page = await browser.context.newPage()
    await page.goto(app.origin)
    // Sign in, exactly as the user would have before recording.
    if (!pageStateAuth) await page.evaluate(() => fetch('/login', { method: 'POST' }).then((r) => r.json()))

    // The relay needs the extension's socket up before a call can be forwarded.
    await waitFor(async () => (await (await douzed.api('/health')).json()).extension_connected, 'extension socket')
    await app.reset()
  }

  test.afterEach(async () => {
    await browser?.dispose()
    await douzed?.stop()
    await app?.stop()
  })

  const call = async (args: Record<string, unknown> = {}) => {
    const res = await douzed.api('/relay/orders/list_orders', { method: 'POST', body: JSON.stringify({ args }) })
    return { status: res.status, body: await res.json() }
  }

  test('@COV_EXE_001.1 should execute with the live browser session', async () => {
    await boot(cookieRecipe('http://127.0.0.1:4180'), false)

    const { body } = await call()
    expect(body.ok).toBe(true)
    expect(body.status).toBe(200)
    expect(body.body).toMatchObject({ data: { orders: expect.any(Array) } })

    // The fixture server must have seen the session cookie on the relayed request.
    const log = await app.log()
    const relayed = log.find((r) => r.path === '/api/orders' && r.method === 'GET')
    expect(relayed).toBeTruthy()
    expect(relayed!.headers['cookie']).toContain('fixture_session=s3ssion-fixture-value')
  })

  test('@COV_EXE_001.2 should carry a page-state credential when the recipe declares one', async () => {
    await boot(pageStateRecipe('http://127.0.0.1:4180'), true)

    const { body } = await call()
    expect(body.ok).toBe(true)
    expect(body.status).toBe(200)

    const log = await app.log()
    const relayed = log.find((r) => r.path === '/api/orders' && r.method === 'GET')
    expect(relayed).toBeTruthy()
    // Both the bearer token and the CSRF header were read from page state and attached.
    expect(relayed!.headers['authorization']).toBe('Bearer page-state-bearer-token-value')
    expect(relayed!.headers['x-csrf-token']).toBe('csrf-fixture-value')

    // AC-EXE-001.3 / TR-6 — neither value was persisted anywhere.
    const registry = JSON.stringify(await (await douzed.api('/registry')).json())
    expect(registry).not.toContain('page-state-bearer-token-value')
    expect(registry).not.toContain('csrf-fixture-value')
  })

  test('@COV_EXE_002.1 should classify a 401 as session_expired and not retry', async () => {
    await boot(cookieRecipe('http://127.0.0.1:4180'), false)
    // Invalidate the session server-side.
    await app.set('sessionValid', false)
    await app.reset()
    await app.set('sessionValid', false)

    const { body } = await call()
    expect(body.error).toBe('session_expired')
    expect(body.message).toMatch(/sign in/i)

    // Exactly one request reached the target — no retry (AC-EXE-002.2).
    const log = (await app.log()).filter((r) => r.path === '/api/orders')
    expect(log).toHaveLength(1)
  })
})

interface DouzeApi {
  __douze: { connect(port: number, token: string): Promise<void> }
}
