import { test, expect, type Page } from '@playwright/test'
import { FixtureApp, Recond, launchHelium } from '../harness.js'

/**
 * COV_CAP_001 — the first thing a user does. Everything downstream is built on these exchanges,
 * so the assertions are about what actually reached the daemon, not what the extension believes.
 */
test.describe('COV_CAP_001: Scoped session capture with bodies', () => {
  let app: FixtureApp
  let recond: Recond
  let browser: Awaited<ReturnType<typeof launchHelium>>
  let page: Page

  test.beforeEach(async () => {
    app = new FixtureApp()
    await app.start()
    await app.reset()

    recond = new Recond()
    await recond.start()

    browser = await launchHelium()
    await browser.serviceWorker.evaluate(
      ([port, token]) => (globalThis as never as ReconTestApi).__recon.connect(Number(port), String(token)),
      [String(recond.port), recond.token] as const,
    )

    page = await browser.context.newPage()
    await page.goto(app.origin)
    // Establish the signed-in session the capture and relay both depend on.
    await page.evaluate(() => fetch('/login', { method: 'POST' }).then((r) => r.json()))
  })

  test.afterEach(async () => {
    await browser.dispose()
    recond.stop()
    app.stop()
  })

  /**
   * startSession reloads the tab itself — a MAIN-world registration does not reach an
   * already-loaded page. Wait for the interceptor to be live again before driving the page,
   * or an evaluate races the navigation and loses its execution context.
   */
  const startSession = async (name: string): Promise<string> => {
    const id = await browser.serviceWorker.evaluate(
      ([name, origin]) => (globalThis as never as ReconTestApi).__recon.startSession(String(name), [String(origin)]),
      [name, app.origin] as const,
    )
    await page.waitForSelector('#create')
    await page.waitForFunction(() => (window as unknown as { __recon_interceptor__?: boolean }).__recon_interceptor__ === true)
    return id
  }

  const stopSession = () =>
    browser.serviceWorker.evaluate(() => (globalThis as never as ReconTestApi).__recon.stopSession())

  const badge = () => browser.serviceWorker.evaluate(() => (globalThis as never as ReconTestApi).__recon.badgeCount())

  test('@COV_CAP_001.1 should capture request and response bodies for in-scope traffic', async () => {
    const sessionId = await startSession('orders')
    expect(sessionId).not.toBe('')

    // A POST that creates an order and a GET that lists them.
    await page.click('#create')
    await page.click('#list')

    await expect.poll(badge, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

    const { retained } = await stopSession()
    expect(retained).toBeGreaterThanOrEqual(2)

    const detail = await (await recond.api(`/sessions/${sessionId}`)).json()
    const create = detail.exchanges.find((e: { method: string }) => e.method === 'POST')
    const list = detail.exchanges.find(
      (e: { method: string; url: string }) => e.method === 'GET' && e.url.endsWith('/api/orders'),
    )

    // AC-CAP-002.1 — method, URL, headers, and BOTH bodies.
    expect(create).toBeTruthy()
    expect(create.request_body).toMatchObject({ item: 'widget', qty: 2 })
    expect(create.response_body).toMatchObject({ data: { order: { item: 'widget' } } })
    expect(create.status).toBe(201)

    expect(list).toBeTruthy()
    expect(list.response_body).toMatchObject({ data: { orders: expect.any(Array) } })
  })

  test('@COV_CAP_001.2 should exclude out-of-scope and noise traffic', async () => {
    const sessionId = await startSession('orders')

    // The page fires a google-analytics beacon and loads a CSS asset on every load.
    await page.reload()
    await page.click('#list')
    await expect.poll(badge, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    await stopSession()
    const detail = await (await recond.api(`/sessions/${sessionId}`)).json()
    const urls = detail.exchanges.map((e: { url: string }) => e.url)

    expect(urls.some((u: string) => u.includes('google-analytics'))).toBe(false)
    expect(urls.some((u: string) => u.endsWith('.css'))).toBe(false)
    expect(urls.every((u: string) => u.startsWith(app.origin))).toBe(true)
  })

  test('@COV_CAP_001.3 should redact credentials before persistence', async () => {
    const sessionId = await startSession('orders')

    // A request carrying both an authorization header and a password in the body.
    await page.evaluate(() =>
      fetch('/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer super-secret-value' },
        body: JSON.stringify({ item: 'bolt', qty: 1, password: 'hunter2' }),
      }).then((r) => r.json()),
    )
    await expect.poll(badge, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await stopSession()

    const detail = await (await recond.api(`/sessions/${sessionId}`)).json()
    const exchange = detail.exchanges.find((e: { method: string }) => e.method === 'POST')

    expect(exchange.request_headers.authorization).toMatch(/^«redacted:string:\d+»$/)
    expect(exchange.request_body.password).toMatch(/^«redacted:string:\d+»$/)
    // AC-CAP-005.3 — the placeholder keeps the length so inference is not degraded.
    expect(exchange.request_body.password).toBe('«redacted:string:7»')
    // And the originals appear nowhere on disk.
    const serialized = JSON.stringify(detail)
    expect(serialized).not.toContain('super-secret-value')
    expect(serialized).not.toContain('hunter2')
  })

  test('@COV_CAP_001.2b should reject a session with an empty name', async () => {
    await expect(startSession('')).rejects.toThrow()
  })
})

/** The service-worker surface the extension exposes for the suite. */
interface ReconTestApi {
  __recon: {
    connect(port: number, token: string): Promise<void>
    startSession(name: string, origins: string[]): Promise<string>
    stopSession(): Promise<{ retained: number }>
    annotate(note: string): Promise<void>
    badgeCount(): number
  }
}
