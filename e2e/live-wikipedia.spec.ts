import { expect, test } from '@playwright/test'
import { HttpMcp, RelayServer, launchHelium, pairRelay, resultText, stopEverything, waitFor } from './harness.js'

/**
 * TASK-025 — a classic server-rendered site: the search form replaces the document, and an exact
 * title match 302s to the article. Build with `DOUZE_FIXTURE_ORIGIN=https://en.wikipedia.org`.
 * Not part of the release gate: it depends on a third party.
 */
const ORIGIN = 'https://en.wikipedia.org'

interface StoredExchange {
  url: string
  method: string
  response_content_type?: string
  response_body?: unknown
}
interface Snapshot {
  url: string
  title: string
  text: string
  links: { label: string; url: string }[]
}

test.afterEach(stopEverything)

test('a Wikipedia search becomes a read tool that returns the article', async () => {
  test.setTimeout(300_000)
  const relay = new RelayServer()
  await relay.start()
  const browser = await launchHelium()
  const { serviceWorker, context, extensionId } = browser
  const workerLog: string[] = []
  serviceWorker.on('console', (message) => workerLog.push(`[sw ${message.type()}] ${message.text()}`))
  expect(await serviceWorker.evaluate((origin) => __douze.hasOrigin(origin), ORIGIN)).toBe(true)

  const page = await context.newPage()
  await page.goto(`${ORIGIN}/wiki/Main_Page`, { waitUntil: 'domcontentloaded' })
  const sessionId = await serviceWorker.evaluate((origin) => __douze.startSession('wikipedia', [origin]), ORIGIN)
  await page.waitForFunction(() => (window as { __douze_interceptor__?: boolean }).__douze_interceptor__ === true, undefined, {
    timeout: 45_000,
  })
  const box = page.locator('input[name="search"]').first()
  await box.waitFor({ timeout: 30_000 })
  // Real keystrokes: the bridge records the submit gesture the navigation is attributed to.
  await box.click()
  await box.fill('Wallet')
  await box.press('Enter')
  await page.waitForURL(/\/wiki\/Wallet|index\.php\?search=/, { timeout: 45_000 })
  await page.waitForLoadState('load')
  await page.waitForTimeout(3000)

  const stopped = await serviceWorker.evaluate(() => __douze.stopSession())
  const captured = await serviceWorker.evaluate((id) => __douze.recorded(id), sessionId)
  const exchanges = captured.exchanges as StoredExchange[]
  console.log(
    `retained=${stopped.retained}\n${JSON.stringify(
      exchanges.map((e) => ({
        method: e.method,
        url: e.url.slice(0, 100),
        ct: e.response_content_type,
        body: typeof e.response_body === 'object' && e.response_body !== null ? Object.keys(e.response_body) : typeof e.response_body,
      })),
      null,
      2,
    )}`,
  )
  console.log(`worker log:\n${workerLog.join('\n')}`)

  const search = exchanges.filter((e) => e.method === 'GET' && /index\.php\?search=/.test(e.url))
  expect(search.length, 'a stored GET /w/index.php?search= navigation').toBeGreaterThan(0)
  const body = search[0]!.response_body as Snapshot
  expect(typeof body).toBe('object')
  expect(body.links.length).toBeGreaterThan(0)
  console.log(`landed: ${body.url}\ntitle: ${body.title}\ntext (${body.text.length}): ${body.text.slice(0, 200)}`)
  console.log(`first links: ${JSON.stringify(body.links.slice(0, 3))}`)

  // --- review ---------------------------------------------------------------
  const review = await context.newPage()
  await review.goto(`chrome-extension://${extensionId}/review.html?session=${sessionId}`)
  await expect.poll(() => review.locator('code.name').count(), { timeout: 30_000 }).toBeGreaterThan(0)
  const state = (await review.evaluate(
    (id) => chrome.runtime.sendMessage({ type: 'douze:review:load', sessionId: id }),
    sessionId,
  )) as { candidates: { name: string; request: { path: string; input_schema?: { properties?: Record<string, unknown>; required?: string[] } } }[] }
  const candidate = state.candidates.find((c) => c.request.path.includes('index.php'))
  console.log(`candidates: ${state.candidates.map((c) => `${c.name} ${c.request.path}`).join(', ')}`)
  expect(candidate, 'a candidate for /w/index.php').toBeDefined()
  console.log(`input schema: ${JSON.stringify(candidate!.request.input_schema)}`)
  await review.locator('#go').click()
  await expect(review.locator('h1')).toContainText('All set')
  const recipeName = await serviceWorker.evaluate(async () => {
    const items = await chrome.storage.local.get(null)
    return Object.keys(items).find((key) => key.startsWith('recipe:'))?.slice('recipe:'.length) ?? ''
  })

  // --- call through the relay ----------------------------------------------
  const endpoint = await relay.register()
  await pairRelay(browser, { url: relay.origin, ...endpoint, allow_writes: false })
  await waitFor(() => serviceWorker.evaluate(() => __douze.attached()), 'the extension to attach to the relay')
  const mcp = new HttpMcp(`${relay.origin}${endpoint.mcp_path}`)
  await mcp.initialize()
  const qualified = `${recipeName}_${candidate!.name}`
  await expect.poll(() => mcp.tools(), { timeout: 30_000 }).toContain(qualified)
  // One observation makes every recorded query parameter required; supply the site's own extras.
  const required = candidate!.request.input_schema?.required ?? []
  const args: Record<string, unknown> = { search: 'Ledger' }
  for (const key of required) if (!(key in args)) args[key] = key === 'title' ? 'Special:Search' : '1'
  const called = await mcp.call(qualified, args)
  const text = resultText(called.body)
  console.log(`tool=${qualified} args=${JSON.stringify(args)} status=${called.status}\n${text.slice(0, 1200)}`)
  expect(called.status).toBe(200)
  expect(called.body.error).toBeUndefined()
  const result = (JSON.parse(text) as { data: Snapshot }).data
  expect(result.url).toMatch(/\/wiki\/Ledger/)
  expect(result.text.toLowerCase()).toContain('ledger')
  expect(result.links.length).toBeGreaterThan(0)
})
