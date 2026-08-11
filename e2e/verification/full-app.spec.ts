import { test, expect } from '@playwright/test'
import { Douzed, FixtureApp, McpClient, launchHelium, spawnMcp, waitFor } from '../harness.js'

/**
 * One golden-path journey through the whole product. Narrower specs own edge cases; this one
 * proves the layers still join up: auth -> capture -> review -> registry -> relay -> MCP.
 */
test('authenticated dashboard becomes a callable MCP tool', async () => {
  test.setTimeout(180_000)

  const app = new FixtureApp()
  const douzed = new Douzed()
  let browser: Awaited<ReturnType<typeof launchHelium>> | undefined
  let mcp: McpClient | undefined

  try {
    await app.start()
    await app.reset()
    await douzed.start()

    // Local API auth is independent of the dashboard session.
    expect((await fetch(`http://127.0.0.1:${douzed.port}/registry`)).status).toBe(401)
    expect(
      (
        await fetch(`http://127.0.0.1:${douzed.port}/pair`, {
          headers: { origin: 'https://not-an-extension.example' },
        })
      ).status,
    ).toBe(403)
    expect((await douzed.api('/registry')).status).toBe(200)

    browser = await launchHelium()
    await browser.serviceWorker.evaluate(
      ([port, token]) => (globalThis as never as DouzeApi).__douze.connect(Number(port), String(token)),
      [String(douzed.port), douzed.token] as const,
    )
    await waitFor(async () => (await (await douzed.api('/health')).json()).extension_connected, 'extension socket')

    const dashboard = await browser.context.newPage()
    await dashboard.goto(app.origin)
    await dashboard.evaluate(() => fetch('/login', { method: 'POST' }).then((response) => response.json()))

    const sessionId = await browser.serviceWorker.evaluate(
      ([origin]) => (globalThis as never as DouzeApi).__douze.startSession('orders', [String(origin)]),
      [app.origin] as const,
    )
    await dashboard.waitForSelector('#list')
    await dashboard.waitForFunction(
      () => (window as unknown as { __douze_interceptor__?: boolean }).__douze_interceptor__ === true,
    )

    for (let index = 0; index < 3; index += 1) {
      await dashboard.click('#list')
      await dashboard.waitForTimeout(150)
    }
    await browser.serviceWorker.evaluate(() =>
      (globalThis as never as DouzeApi).__douze.annotate('lists the current orders'),
    )
    await expect
      .poll(
        () => browser!.serviceWorker.evaluate(() => (globalThis as never as DouzeApi).__douze.badgeCount()),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(3)
    await browser.serviceWorker.evaluate(() => (globalThis as never as DouzeApi).__douze.stopSession())

    const captured = await waitForCapture(douzed, sessionId)
    expect(captured.exchanges.filter((exchange) => exchange.method === 'GET' && exchange.url.endsWith('/api/orders')))
      .toHaveLength(3)
    expect(JSON.stringify(captured)).not.toContain('s3ssion-fixture-value')

    // Review auth: the session is not disclosed without the local install token.
    const hidden = await fetch(`http://127.0.0.1:${douzed.port}/review/${sessionId}`)
    expect(hidden.status).toBe(401)
    expect(await hidden.text()).not.toContain(app.origin)

    const review = await browser.context.newPage()
    await review.goto(`http://127.0.0.1:${douzed.port}/review/${sessionId}?token=${douzed.token}`)
    await expect
      .poll(() => review.locator('code.name').allTextContents(), { timeout: 15_000 })
      .toContain('list_orders')
    await review.locator('#go').click()
    await expect(review.locator('h1')).toContainText('All set')

    await expect
      .poll(
        async () => ((await (await douzed.api('/registry')).json()).tools as SurfaceTool[]).map((tool) => tool.qualified_name),
        { timeout: 15_000 },
      )
      .toContain('orders_list_orders')

    const recipes = (await (await douzed.api('/recipes')).json()) as RecipeView[]
    expect(recipes.find((recipe) => recipe.name === 'orders')?.auth).toMatchObject({
      mode: 'browser_relay',
      credential_source: [{ kind: 'cookie' }],
    })

    // The daemon API calls the approved tool inside the signed-in browser.
    await app.reset()
    const relayed = await douzed.api('/relay/orders/list_orders', {
      method: 'POST',
      body: JSON.stringify({ args: {} }),
    })
    expect(relayed.status).toBe(200)
    expect(await relayed.json()).toMatchObject({ ok: true, status: 200, body: { data: { orders: expect.any(Array) } } })
    expect((await ordersRequests(app))[0]?.headers['cookie']).toContain('fixture_session=s3ssion-fixture-value')

    // The same hot-loaded tool is exposed and callable over a real MCP stdio session.
    mcp = new McpClient(spawnMcp(douzed.home))
    await mcp.initialize()
    await expect.poll(() => mcp!.tools(), { timeout: 30_000 }).toContain('orders_list_orders')
    const result = (await mcp.request('tools/call', {
      name: 'orders_list_orders',
      arguments: {},
    })) as McpResult
    expect(result.isError ?? false).toBe(false)
    expect(result.content[0]?.text).toContain('widget')

    // Expired target auth is classified once and never retried.
    await app.reset()
    await app.set('sessionValid', false)
    const expired = await douzed.api('/relay/orders/list_orders', {
      method: 'POST',
      body: JSON.stringify({ args: {} }),
    })
    expect(expired.status).toBe(502)
    expect(await expired.json()).toMatchObject({ error: 'session_expired' })
    expect(await ordersRequests(app)).toHaveLength(1)
  } finally {
    mcp?.kill()
    await browser?.dispose()
    await douzed.stop()
    await app.stop()
  }
})

async function waitForCapture(douzed: Douzed, sessionId: string): Promise<CaptureView> {
  let captured: CaptureView = { exchanges: [] }
  await expect
    .poll(async () => {
      captured = (await (await douzed.api(`/sessions/${sessionId}`)).json()) as CaptureView
      return captured.exchanges.filter((exchange) => exchange.url.endsWith('/api/orders')).length
    })
    .toBeGreaterThanOrEqual(3)
  return captured
}

const ordersRequests = async (app: FixtureApp) => (await app.log()).filter((request) => request.path === '/api/orders')

interface DouzeApi {
  __douze: {
    connect(port: number, token: string): Promise<void>
    startSession(name: string, origins: string[]): Promise<string>
    stopSession(): Promise<{ retained: number }>
    annotate(note: string): Promise<void>
    badgeCount(): number
  }
}

interface CaptureView {
  exchanges: { method: string; url: string }[]
}

interface SurfaceTool {
  qualified_name: string
}

interface RecipeView {
  name: string
  auth: { mode: string; credential_source: { kind: string }[] }
}

interface McpResult {
  isError?: boolean
  content: { text: string }[]
}
