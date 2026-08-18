/**
 * Proves the built extension actually loads and captures: Helium boots it, the MV3 service
 * worker runs its top-level registrations, the popup renders, and a session on the fixture app
 * records real exchanges. Not the e2e suite — that lives in `e2e/`.
 *
 *   DOUZE_TEST_ORIGIN=http://127.0.0.1:4180 pnpm --filter @douze/extension build
 *   node packages/extension/smoke.mjs
 *
 * Without a fixture server on 4180 the capture section is skipped and the rest still runs.
 */
import { chromium } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist')
const HELIUM = process.env.HELIUM_PATH ?? '/Applications/Helium.app/Contents/MacOS/Helium'
const FIXTURE = 'http://127.0.0.1:4180'

const checks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push({ name, ok, actual, expected })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`)
}

// Content scripts are injected as classic scripts: an import statement would break injection.
for (const file of ['interceptor.js', 'bridge.js']) {
  const source = readFileSync(join(DIST, file), 'utf8')
  check(`${file} bundles to a self-contained classic script`, /(^|\n)\s*(import|export)\s/.test(source), false)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'douze-smoke-'))
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: HELIUM,
  headless: false,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
})

try {
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 })
  const extensionId = new URL(worker.url()).host
  console.log(`extension id  : ${extensionId}`)
  console.log(`service worker: ${worker.url()}`)

  check('service worker loaded background.js', worker.url().endsWith('/background.js'), true)
  check(
    'manifest is the Douze MV3 manifest',
    await worker.evaluate(() => {
      const m = chrome.runtime.getManifest()
      return [m.name, m.manifest_version, m.minimum_chrome_version]
    }),
    ['Douze', 3, '116'],
  )

  check(
    'badge is clear with no session running',
    await worker.evaluate(() => chrome.action.getBadgeText({})),
    '',
  )
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  // Opened over `chrome-extension://`, which is not a site Douze can watch. Nothing here waits on
  // a service being up: with no daemon there is no "can't reach it" state to be in.
  await popup.waitForSelector('#unsupported:not([hidden])')
  check('popup renders its brand', (await popup.textContent('.brand'))?.includes('Douze'), true)
  check('popup renders the 12 mark', await popup.getAttribute('.brand img', 'src'), 'icon128.png')
  check('popup offers no way to record a page it cannot watch', await popup.isVisible('#watch'), false)
  check('popup asks for no port or token', await popup.locator('#port, #token').count(), 0)
  check('popup has no daemon screen left to show', await popup.locator('#disconnected').count(), 0)

  // Extension pages are the only context whose sendMessage the worker receives — and the round
  // trip is also the proof that the top-level `onMessage` registration ran.
  check(
    'popup command round-trips through the worker',
    await popup.evaluate(async () => {
      const status = await chrome.runtime.sendMessage({ type: 'douze:status' })
      return [status.session, status.count]
    }),
    [null, 0],
  )
  // An unnamed session is named after the site, not refused: only a missing tab can stop it.
  check(
    'a session start with an empty name is not refused for its name',
    await popup.evaluate(async () => {
      const res = await chrome.runtime.sendMessage({
        type: 'douze:start',
        name: '  ',
        origins: ['https://app.example'],
      })
      return typeof res.error === 'string' && res.error.includes('no open tab')
    }),
    true,
  )

  // --- capture against the fixture app -------------------------------------
  const fixtureUp = await fetch(FIXTURE).then(
    (r) => r.ok,
    () => false,
  )
  if (!fixtureUp) {
    console.log('SKIP  capture section — no fixture server on 4180 (npx tsx fixtures/server.ts)')
  } else if (!(await worker.evaluate((o) => globalThis.__douze.hasOrigin(o), FIXTURE))) {
    console.log('SKIP  capture section — build without DOUZE_TEST_ORIGIN, host permission absent')
  } else {
    const app = await context.newPage()
    await app.goto(FIXTURE)
    // startSession reloads the tab itself: registrations do not reach an already-loaded tab.
    const sessionId = await worker.evaluate((o) => globalThis.__douze.startSession('orders', [o]), FIXTURE)
    await app.waitForSelector('#create')
    check(
      'interceptor is in the page after startSession reloaded it',
      await app.evaluate(() => window.__douze_interceptor__ === true),
      true,
    )

    // Back to back: both clicks and both exchanges land in one bridge batch, which is the
    // case that used to smear the second click's provenance onto the first exchange.
    await app.click('#create')
    await app.click('#list')
    // Then idle past the 2s attribution window so the later polls have no gesture to claim.
    await app.waitForTimeout(3500)

    // Read back out of the extension's own store — there is no outbox to inspect, because there
    // is nothing to send anything to.
    const captured = await worker.evaluate(
      async (id) =>
        (await globalThis.__douze.recorded(id)).exchanges.map((exchange) => ({
          url: exchange.url,
          method: exchange.method,
          background: exchange.background,
          name: exchange.provenance?.accessible_name ?? null,
          hasReq: exchange.request_body !== undefined,
          hasRes: exchange.response_body !== undefined,
        })),
      sessionId,
    )
    const post = captured.find((e) => e.method === 'POST' && e.url.endsWith('/api/orders'))
    const get = captured.find((e) => e.method === 'GET' && e.url.endsWith('/api/orders'))

    check('POST create captured with both bodies (AC-CAP-002.1)', [!!post, post?.hasReq, post?.hasRes], [true, true, true])
    check('GET list captured with a response body', [!!get, get?.hasRes], [true, true])
    check('click provenance attached (AC-CAP-003.1)', [post?.name, get?.name], ['Create order', 'List orders'])
    // AC-CAP-003.3 is about requests no gesture preceded *within the window*. Polls firing 1-2s
    // after a click legitimately fall inside it; the one after the idle wait must not.
    const polls = captured.filter((e) => e.url.includes('/api/poll'))
    const lastPoll = polls.at(-1)
    check(
      'a poll outside the gesture window is background with no provenance (AC-CAP-003.3)',
      [polls.length > 0, lastPoll?.background, lastPoll?.name],
      [true, true, null],
    )
    check(
      'analytics and the CSS asset are absent (AC-CAP-001.2 / 004.1 / 004.2)',
      captured.filter((e) => e.url.includes('google-analytics') || e.url.endsWith('.css')).length,
      0,
    )
    check('badge reflects the captured count (AC-CAP-001.3)', await worker.evaluate(() => globalThis.__douze.badgeCount()), captured.length)

    await worker.evaluate(() => globalThis.__douze.annotate('creates an order'))
    const span = await worker.evaluate(
      async (id) => (await globalThis.__douze.recorded(id)).annotations.at(-1) ?? null,
      sessionId,
    )
    check('annotation spans the exchanges since the last note (AC-CAP-007.2)', [span?.note, span?.start_position], ['creates an order', 0])

    const stopped = await worker.evaluate(() => globalThis.__douze.stopSession())
    check('stop reports the retained count (AC-CAP-001.4)', stopped.retained, captured.length)
    check('badge clears on stop', await worker.evaluate(() => globalThis.__douze.badgeCount()), 0)
  }
} finally {
  await context.close()
  rmSync(userDataDir, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
