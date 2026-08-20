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

/** The term typed into the site's own form while recording. */
const RECORDED_TERM = 'gasket'
/** A different term for the replay — the fixture echoes it, so the result cannot be the capture. */
const REPLAY_TERM = 'flange'
/** Lives in the result page's `<script>`; see `serveSearch` in fixtures/server.ts. */
const SCRIPT_MARKER = 'FIXTURE_SCRIPT_MARKER'

/**
 * The snapshot shape, declared here rather than imported: this spec asserts on what came back over
 * MCP, and a spec that imported the extension's own type would be checking a build artefact
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
 * TASK-024 — the other half of the search survey: a form with no JavaScript on it at all. Submitting
 * it unloads the document, the server answers `302 /results/<term>/`, and the browser lands on a
 * page the recorded tab never fetched. Nothing the soft-navigation path relies on is present: no
 * `fetch`, no response body in the interceptor, no request the reconciler ever sees.
 *
 * What has to be true afterwards is the same as for a fetched route: one exchange, whose `url` is
 * the URL replay will re-issue (`/find/?q=…`, REQ-015) and whose body is a snapshot of where the
 * server actually landed. And what must NOT be there is a document exchange for the reload
 * `startSession` performs itself — no gesture preceded it, so it is not a read the user asked for
 * (REQ-012).
 */
test('a form submit that replaces the document records, reviews and replays as a read tool', async () => {
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

  const sessionId = await serviceWorker.evaluate((origin) => __douze.startSession('nav', [origin]), app.origin)
  // startSession reloads the tab itself; the interceptor lands with that load. That reload is also
  // the navigation this spec later proves was ignored — nobody clicked anything to cause it.
  await dashboard.waitForSelector('#find')
  await dashboard.waitForFunction(() => (window as { __douze_interceptor__?: boolean }).__douze_interceptor__ === true)

  // The search: typed into the site's own form, which has no submit handler. The click unloads the
  // page, so the gesture has to reach the worker before the document goes (REQ-014).
  await dashboard.fill('#find-q', RECORDED_TERM)
  await dashboard.click('#find button')
  await dashboard.waitForURL(/\/results\//)
  await dashboard.waitForSelector(`main h1:text-is("Results for ${RECORDED_TERM}")`)

  // One more request from the page the browser landed on, and then Done: proof the recorder is
  // still watching a tab whose document was replaced under it.
  await dashboard.evaluate(() =>
    fetch('/api/orders?tail=1', { credentials: 'include' }).then((response) => response.json()),
  )
  const stopped = await serviceWorker.evaluate(() => __douze.stopSession())
  expect(stopped.retained).toBeGreaterThan(0)

  // --- what the session holds --------------------------------------------
  const { exchanges } = await serviceWorker.evaluate((id) => __douze.recorded(id), sessionId)
  const stored = exchanges as { url: string; response_body?: unknown }[]
  expect(stored.map((exchange) => exchange.url).some((url) => url.includes('tail=1'))).toBe(true)

  const navigations = stored.filter((exchange) => exchange.url.includes('/find/?q='))
  expect(navigations, 'the form submit produced no exchange, or more than one').toHaveLength(1)
  // REQ-015 — the exchange is keyed by what replay re-issues, not by where the server landed.
  expect(navigations[0]!.url).toContain(`/find/?q=${RECORDED_TERM}`)
  const snapshot = navigations[0]!.response_body as Snapshot
  expect(typeof snapshot).toBe('object')
  expect(snapshot.url).toContain('/results/')
  expect(snapshot.links.map((link) => link.label)).toEqual([
    `First result about ${RECORDED_TERM}`,
    `Second result about ${RECORDED_TERM}`,
  ])
  const wholeSession = JSON.stringify(exchanges)
  expect(wholeSession).not.toContain(SCRIPT_MARKER)
  expect(wholeSession).not.toContain('<main>')

  // REQ-012 — the reload `startSession` performed is a navigation with no gesture behind it. A
  // document exchange for the page root would mean every session begins by recording its own reload.
  const reloads = stored.filter(
    (exchange) =>
      (exchange.url === `${app.origin}/` || exchange.url === app.origin) &&
      typeof exchange.response_body === 'object' &&
      exchange.response_body !== null,
  )
  expect(reloads, 'the startSession reload was recorded as a document read').toHaveLength(0)

  // --- review -------------------------------------------------------------
  const review = await context.newPage()
  await review.goto(`chrome-extension://${extensionId}/review.html?session=${sessionId}`)
  await expect.poll(() => review.locator('code.name').count(), { timeout: 20_000 }).toBeGreaterThan(0)
  const state = (await review.evaluate(
    (id) => chrome.runtime.sendMessage({ type: 'douze:review:load', sessionId: id }),
    sessionId,
  )) as { candidates: Candidate[] }

  const documentTool = state.candidates.find((candidate) => candidate.request.path.startsWith('/find'))
  expect(documentTool, 'the navigated route produced no candidate').toBeDefined()
  expect(documentTool!.side_effect).toBe('read')
  expect(documentTool!.request.method).toBe('GET')
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
  const replayed = (JSON.parse(resultText(called.body)) as { data: Snapshot }).data
  expect(replayed.links).toEqual([
    { label: `First result about ${REPLAY_TERM}`, url: `${app.origin}/r/one/comments/1/first-result` },
    { label: `Second result about ${REPLAY_TERM}`, url: `${app.origin}/r/two/comments/2/second-result` },
  ])
  // REQ-016 — the tool asked for `/find/`, which answers nothing but a `Location`. Content only
  // exists here because the replay followed it.
  expect(replayed.url).toContain(`/results/${REPLAY_TERM}/`)
  expect(replayed.text).toContain(`Results for ${REPLAY_TERM}`)
  expect(JSON.stringify(replayed)).not.toContain(SCRIPT_MARKER)

  // The only evidence the reply came from the signed-in browser rather than from the capture: both
  // legs of the redirect were issued, in order, carrying the session cookie.
  const requests = (await app.log()).filter(
    (entry) => entry.path === '/find/' || entry.path.startsWith('/results/'),
  )
  expect(requests.map((entry) => entry.path)).toEqual(['/find/', `/results/${REPLAY_TERM}/`])
  for (const entry of requests) expect(entry.headers['cookie']).toContain('fixture_session=s3ssion-fixture-value')
})
