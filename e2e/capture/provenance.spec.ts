import { test, expect, type Page } from '@playwright/test'
import { FixtureApp, Douzed, launchHelium } from '../harness.js'

/**
 * COV_CAP_003 — intent, not just traffic. The assertions read the PERSISTED exchange back from
 * douzed rather than the extension's outbox, because provenance that never survives the socket
 * is provenance inference will never see.
 */
test.describe('COV_CAP_003: Provenance attribution', () => {
  let app: FixtureApp
  let douzed: Douzed
  let browser: Awaited<ReturnType<typeof launchHelium>>
  let page: Page

  test.beforeEach(async () => {
    app = new FixtureApp()
    await app.start()
    await app.reset()

    douzed = new Douzed()
    await douzed.start()

    browser = await launchHelium()
    await browser.serviceWorker.evaluate(
      ([port, token]) => (globalThis as never as DouzeTestApi).__douze.connect(Number(port), String(token)),
      [String(douzed.port), douzed.token] as const,
    )

    page = await browser.context.newPage()
    await page.goto(app.origin)
    // Establish the signed-in session the capture depends on.
    await page.evaluate(() => fetch('/login', { method: 'POST' }).then((r) => r.json()))
  })

  test.afterEach(async () => {
    await browser.dispose()
    await douzed.stop()
    await app.stop()
  })

  /**
   * startSession reloads the tab itself — a MAIN-world registration does not reach an
   * already-loaded page. Wait for the interceptor to be live again before driving the page,
   * or an evaluate races the navigation and loses its execution context.
   */
  const startSession = async (name: string): Promise<string> => {
    const id = await browser.serviceWorker.evaluate(
      ([name, origin]) => (globalThis as never as DouzeTestApi).__douze.startSession(String(name), [String(origin)]),
      [name, app.origin] as const,
    )
    await page.waitForSelector('#create')
    await page.waitForFunction(() => (window as unknown as { __douze_interceptor__?: boolean }).__douze_interceptor__ === true)
    return id
  }

  const stopSession = () =>
    browser.serviceWorker.evaluate(() => (globalThis as never as DouzeTestApi).__douze.stopSession())

  /** What douzed has actually stored for the session so far. */
  const exchanges = async (sessionId: string): Promise<StoredExchange[]> =>
    (await (await douzed.api(`/sessions/${sessionId}`)).json()).exchanges

  test('@COV_CAP_003.1 should attach the activating control to a user-initiated request', async () => {
    const sessionId = await startSession('orders')

    await page.click('#create')

    // Wait on the POST specifically: the fixture polls in the background, so a badge or a plain
    // "any exchange arrived" wait can be satisfied by traffic this assertion is not about.
    await expect
      .poll(async () => (await exchanges(sessionId)).some((e) => e.method === 'POST'), { timeout: 15_000 })
      .toBe(true)
    await stopSession()

    const create = (await exchanges(sessionId)).find((e) => e.method === 'POST' && e.url.endsWith('/api/orders'))
    expect(create).toBeTruthy()

    // AC-CAP-003.1 — the control the user activated within the preceding 2 seconds.
    expect(create!.background).toBe(false)
    expect(create!.provenance).toMatchObject({ accessible_name: 'Create order', role: 'button' })
    // AC-CAP-003.2 — plus where in the app it happened. The fixture SPA serves one route.
    expect(create!.provenance).toMatchObject({ route: '/', title: 'Fixture Orders' })
  })

  test('@COV_CAP_003.2 should mark polling traffic as background', async () => {
    const sessionId = await startSession('orders')

    // No interaction at all. The fixture polls /api/poll every second on its own, and the tab
    // reload startSession performed is not a gesture — so nothing may be attributed to a user.
    await page.waitForTimeout(5_000)
    await stopSession()

    const captured = await exchanges(sessionId)
    // Prove capture was actually live, otherwise "every exchange is background" is vacuous.
    expect(captured.length).toBeGreaterThanOrEqual(3)
    expect(captured.every((e) => e.url.includes('/api/poll'))).toBe(true)

    // AC-CAP-003.3 — a stale gesture must never be attached; the exchange is marked instead.
    for (const exchange of captured) {
      expect(exchange.background).toBe(true)
      expect(exchange.provenance).toBeUndefined()
    }
  })
})

/** Only the fields these assertions read; the daemon returns the full `Exchange`. */
interface StoredExchange {
  method: string
  url: string
  background: boolean
  provenance?: { accessible_name: string; role: string; route: string; title: string }
}

/** The service-worker surface the extension exposes for the suite. */
interface DouzeTestApi {
  __douze: {
    connect(port: number, token: string): Promise<void>
    startSession(name: string, origins: string[]): Promise<string>
    stopSession(): Promise<{ retained: number }>
  }
}
