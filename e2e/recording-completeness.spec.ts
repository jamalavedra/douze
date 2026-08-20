import { test, expect } from '@playwright/test'
import {
  FixtureApp,
  HttpMcp,
  RelayServer,
  launchHelium,
  pairRelay,
  resultText,
  stopEverything,
  waitFor,
} from './harness.js'

// Not a `finally`: a Playwright TIMEOUT abandons the test body, and the fixture app and the relay
// then outlive the run and break the next one's "port is free" wait.
test.afterEach(stopEverything)

/** The term typed into the site's own search box while recording. */
const RECORDED_TERM = 'gasket'
/** A different term for the replay — the fixture echoes it, so the result cannot be the capture. */
const REPLAY_TERM = 'flange'
/** Lives in the search page's `<script>`; see `serveSearch` in fixtures/server.ts. */
const SCRIPT_MARKER = 'FIXTURE_SCRIPT_MARKER'

/**
 * The snapshot shape, declared here rather than imported: this spec asserts on what came back
 * over MCP, and a spec that imported the extension's own type would be checking a build artefact
 * against itself. `document.spec.ts` is where the extractor's contract is tested.
 */
interface Snapshot {
  url: string
  title: string
  text: string
  links: { label: string; url: string }[]
}

interface Candidate {
  name: string
  side_effect: string
  request: { method: string; path: string; input_schema?: { properties?: Record<string, unknown> } }
}

/**
 * TASK-013 + TASK-014 — everything a recording of a page-rendered read has to survive, in one
 * session, because the interesting failures are all about what is *missing* afterwards.
 *
 * The site fetches its search route as HTML and swaps `<main>` — a soft navigation, the shape the
 * plan's §0 observed in the wild. Nothing here names or special-cases that site: what makes the
 * search a tool is the content type and the method, and what makes the reply readable is the same
 * extractor at capture and at replay.
 *
 * Done is pressed with a request still inside the bridge's batch window, deliberately: the two
 * reliability fixes this spec covers (the tab gate and the stop-time flush) are only visible in
 * the exchanges a session ends up holding.
 */
test('a page-rendered search records, reviews and replays as a read tool', async () => {
  test.setTimeout(240_000)

  const app = new FixtureApp()
  const relay = new RelayServer()

  await app.start()
  await app.reset()
  await relay.start()
  const browser = await launchHelium()
  const { serviceWorker, context, extensionId } = browser

  // --- record ------------------------------------------------------------
  const dashboard = await context.newPage()
  await dashboard.goto(app.origin)
  await dashboard.evaluate(() => fetch('/login', { method: 'POST' }).then((response) => response.json()))

  const sessionId = await serviceWorker.evaluate((origin) => __douze.startSession('docs', [origin]), app.origin)
  // startSession reloads the tab itself; the interceptor lands with that load.
  await dashboard.waitForSelector('#search')
  await dashboard.waitForFunction(() => (window as { __douze_interceptor__?: boolean }).__douze_interceptor__ === true)

  // TASK-014(a) — a second tab on the SAME granted origin, recording something the user is not
  // doing. The content script is registered per origin, so it runs there too and sends its batches
  // to the same worker; only the recorded tab's id may reach `ingest`.
  const other = await context.newPage()
  await other.goto(app.origin)
  await other.waitForFunction(() => (window as { __douze_interceptor__?: boolean }).__douze_interceptor__ === true)
  const polled = await other.evaluate(() =>
    fetch('/api/poll?tab=second', { credentials: 'include' }).then((response) => response.json()),
  )
  // Without this the assertion below passes for the wrong reason — a request that never happened
  // is also a request that was not stored.
  expect(polled).toHaveProperty('data')
  await other.close()

  // The search: typed into the site's own form, which fetches the route and swaps `<main>` in.
  await dashboard.fill('#q', RECORDED_TERM)
  await dashboard.click('#search button')
  await dashboard.waitForSelector(`main h1:text-is("Results for ${RECORDED_TERM}")`)

  // TASK-014(b) — one more request, completed, and then Done with no pause at all: this is inside
  // the bridge's 250 ms batch and the reconciler's grace, which is exactly where a request used to
  // be lost.
  await dashboard.evaluate(() =>
    fetch('/api/orders?tail=1', { credentials: 'include' }).then((response) => response.json()),
  )
  const stopped = await serviceWorker.evaluate(() => __douze.stopSession())
  expect(stopped.retained).toBeGreaterThan(0)

  // --- what the session holds --------------------------------------------
  const { exchanges } = await serviceWorker.evaluate((id) => __douze.recorded(id), sessionId)
  const urls = (exchanges as { url: string }[]).map((exchange) => exchange.url)
  expect(urls.some((url) => url.includes('tab=second'))).toBe(false)
  expect(urls.some((url) => url.includes('tail=1'))).toBe(true)

  const search = (exchanges as { url: string; response_body?: unknown }[]).find((exchange) =>
    exchange.url.includes('/search/'),
  )
  expect(search, 'the search fetch was not recorded').toBeDefined()
  // REQ-001/REQ-005 — the body is the snapshot, and the HTML that produced it never reached disk.
  const stored = search!.response_body as Snapshot
  expect(typeof stored).toBe('object')
  expect(Array.isArray(stored.links)).toBe(true)
  expect(stored.links.map((link) => link.label)).toEqual([
    `First result about ${RECORDED_TERM}`,
    `Second result about ${RECORDED_TERM}`,
  ])
  const wholeSession = JSON.stringify(exchanges)
  expect(wholeSession).not.toContain(SCRIPT_MARKER)
  expect(wholeSession).not.toContain('<main>')

  // --- review -------------------------------------------------------------
  const review = await context.newPage()
  await review.goto(`chrome-extension://${extensionId}/review.html?session=${sessionId}`)
  await expect.poll(() => review.locator('code.name').count(), { timeout: 20_000 }).toBeGreaterThan(0)
  const state = (await review.evaluate(
    (id) => chrome.runtime.sendMessage({ type: 'douze:review:load', sessionId: id }),
    sessionId,
  )) as { candidates: Candidate[] }

  const documentTool = state.candidates.find((candidate) => candidate.request.path.startsWith('/search'))
  expect(documentTool, 'the page-rendered route produced no candidate').toBeDefined()
  expect(documentTool!.side_effect).toBe('read')
  expect(documentTool!.request.method).toBe('GET')
  // ASSUMPTION-001 — `?q=gasket` is a `q` parameter, which is what makes the tool callable with
  // anything other than the term that was recorded.
  expect(Object.keys(documentTool!.request.input_schema?.properties ?? {})).toContain('q')

  // Everything Douze found is selected; approving is the same click a reader makes.
  await review.locator('#go').click()
  await expect(review.locator('h1')).toContainText('All set')

  const recipeName = await serviceWorker.evaluate(async () => {
    const items = await chrome.storage.local.get(null)
    return Object.keys(items).find((key) => key.startsWith('recipe:'))?.slice('recipe:'.length) ?? ''
  })
  expect(recipeName).not.toBe('')

  // --- call it, with a term that was never recorded -----------------------
  const endpoint = await relay.register()
  await pairRelay(browser, { url: relay.origin, ...endpoint, allow_writes: false })
  await waitFor(() => serviceWorker.evaluate(() => __douze.attached()), 'the extension to attach to the relay')

  const mcp = new HttpMcp(`${relay.origin}${endpoint.mcp_path}`)
  await mcp.initialize()
  const toolName = `${recipeName}_${documentTool!.name}`
  await expect.poll(() => mcp.tools(), { timeout: 20_000 }).toContain(toolName)

  await app.reset()
  const called = await mcp.call(toolName, { q: REPLAY_TERM })
  expect(called.status).toBe(200)
  expect(called.body.error).toBeUndefined()

  // Results ride under `data` beside the status and duration (`capResult` in guards.ts).
  const snapshot = (JSON.parse(resultText(called.body)) as { data: Snapshot }).data
  expect(snapshot.links).toEqual([
    { label: `First result about ${REPLAY_TERM}`, url: `${app.origin}/r/one/comments/1/first-result` },
    { label: `Second result about ${REPLAY_TERM}`, url: `${app.origin}/r/two/comments/2/second-result` },
  ])
  expect(snapshot.text).toContain(`Results for ${REPLAY_TERM}`)
  // REQ-003 — script text is markup, and markup is not what an assistant is being handed.
  expect(snapshot.text).not.toContain(SCRIPT_MARKER)
  expect(JSON.stringify(snapshot)).not.toContain(SCRIPT_MARKER)

  // The only evidence the reply came from the signed-in browser rather than from the capture.
  const requests = (await app.log()).filter((entry) => entry.path === '/search/')
  expect(requests).toHaveLength(1)
  expect(requests[0]!.headers['cookie']).toContain('fixture_session=s3ssion-fixture-value')
})
