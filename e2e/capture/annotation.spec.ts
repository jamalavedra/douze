import { test, expect, type Page } from '@playwright/test'
import { FixtureApp, Douzed, launchHelium } from '../harness.js'
import { infer, type InferenceInput } from '../../packages/studio/src/inference/engine.js'

/**
 * COV_CAP_007 — the note the user types is the strongest evidence inference ever gets, so these
 * assertions run the REAL engine over what douzed persisted rather than trusting the span alone.
 * ADR-006 keeps inference out of the daemon, so it is imported here instead of called over HTTP.
 */
const NOTE = 'transitions an issue to done'

test.describe('COV_CAP_007: Usage annotation', () => {
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
    douzed.stop()
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

  const annotate = (note: string) =>
    browser.serviceWorker.evaluate((n) => (globalThis as never as DouzeTestApi).__douze.annotate(String(n)), note)

  const detail = async (sessionId: string): Promise<SessionDetail> =>
    (await douzed.api(`/sessions/${sessionId}`)).json()

  /** Waits until douzed has stored an exchange matching `match`, then returns everything stored. */
  const waitForExchange = async (sessionId: string, match: (e: StoredExchange) => boolean): Promise<void> => {
    await expect
      .poll(async () => (await detail(sessionId)).exchanges.some(match), { timeout: 15_000 })
      .toBe(true)
  }

  const isCreate = (e: StoredExchange) => e.method === 'POST' && e.url.endsWith('/api/orders')
  const isList = (e: StoredExchange) => e.method === 'GET' && e.url.endsWith('/api/orders')
  const isGraphql = (e: StoredExchange) => e.url.endsWith('/graphql')

  test('@COV_CAP_007.1 should attach a recorded note to the candidates derived from its span', async () => {
    const sessionId = await startSession('orders')

    // Two requests, then the note that describes them.
    await page.click('#create')
    await page.click('#list')
    // Both must be PERSISTED before annotating: the daemon derives the span's end from the
    // highest position it has stored, so annotating early would cut the span short.
    await waitForExchange(sessionId, isCreate)
    await waitForExchange(sessionId, isList)

    await annotate(NOTE)

    // A third request, of a shape neither earlier one shares, so its candidate is unambiguous.
    await page.click('#gql')
    await waitForExchange(sessionId, isGraphql)
    await stopSession()

    const { exchanges, annotations } = await detail(sessionId)
    expect(annotations).toHaveLength(1)
    const span = annotations[0]!
    expect(span.note).toBe(NOTE)

    const create = exchanges.find(isCreate)!
    const list = exchanges.find(isList)!
    const graphql = exchanges.find(isGraphql)!

    /**
     * AC-CAP-007.1 / .2 — the span covers every exchange captured SINCE the previous note. There
     * is no previous note, so it starts at 0 and ends at the last exchange stored when the note
     * arrived: the two requests the user had just made. The third happened after the note, so the
     * note cannot describe it (`capture-store.ts` annotate()).
     */
    expect(span.start_position).toBe(0)
    expect(create.position).toBeLessThanOrEqual(span.end_position)
    expect(list.position).toBeLessThanOrEqual(span.end_position)
    expect(graphql.position).toBeGreaterThan(span.end_position)

    // AC-CAP-007.3 / .5 — and the span reaches the candidates, which is the point of recording it.
    const candidates = infer({
      exchanges: exchanges as InferenceInput['exchanges'],
      annotations: annotations as InferenceInput['annotations'],
    })
    const created = candidates.find((c) => c.tool.request.method === 'POST' && c.tool.request.path === '/api/orders')
    const listed = candidates.find((c) => c.tool.request.method === 'GET' && c.tool.request.path === '/api/orders')
    const issue = candidates.find((c) => c.tool.request.graphql?.operation === 'CreateIssue')

    expect(created?.tool.annotation).toBe(NOTE)
    expect(listed?.tool.annotation).toBe(NOTE)
    expect(issue).toBeTruthy()
    expect(issue?.tool.annotation).toBeUndefined()
  })

  test('@COV_CAP_007.2 should produce candidates from an unannotated session', async () => {
    const sessionId = await startSession('orders')

    await page.click('#create')
    await page.click('#list')
    await waitForExchange(sessionId, isCreate)
    await waitForExchange(sessionId, isList)
    await stopSession()

    const { exchanges, annotations } = await detail(sessionId)
    expect(annotations).toHaveLength(0)

    // AC-CAP-007.4 — annotation is never required to complete a session, so the engine is given
    // no `annotations` key at all rather than an empty one.
    const candidates = infer({ exchanges: exchanges as InferenceInput['exchanges'] })

    expect(candidates.length).toBeGreaterThan(0)
    expect(
      candidates.some((c) => c.tool.request.method === 'POST' && c.tool.request.path === '/api/orders'),
    ).toBe(true)

    // Nothing is blocked or held back waiting for a note: every candidate is complete and usable.
    for (const candidate of candidates) {
      expect(candidate.tool.annotation).toBeUndefined()
      expect(candidate.tool.name).not.toBe('')
      expect(candidate.tool.description.length).toBeGreaterThan(0)
      expect(candidate.tool.observations).toBeGreaterThan(0)
      expect(candidate.evidence.exchange_ids.length).toBeGreaterThan(0)
    }
  })
})

/** Only the fields these assertions read; the daemon returns the full documents. */
interface StoredExchange {
  method: string
  url: string
  position: number
}

interface SessionDetail {
  exchanges: StoredExchange[]
  annotations: { note: string; start_position: number; end_position: number }[]
}

/** The service-worker surface the extension exposes for the suite. */
interface DouzeTestApi {
  __douze: {
    connect(port: number, token: string): Promise<void>
    startSession(name: string, origins: string[]): Promise<string>
    stopSession(): Promise<{ retained: number }>
    annotate(note: string): Promise<void>
  }
}
