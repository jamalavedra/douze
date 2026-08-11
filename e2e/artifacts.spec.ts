import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EXTENSION, FixtureApp, launchHelium, stopEverything, waitFor, type Browser } from './harness.js'

// Not a `finally`: a Playwright TIMEOUT abandons the test body, and the fixture app then outlives
// the run and breaks the next one's "port is free" wait.
test.afterEach(stopEverything)

/**
 * V-015.4 — what has to be true of the artefacts themselves.
 *
 * The secret sweep is `metrics.mjs` re-pointed: it walked `DOUZE_HOME`, a filesystem that no
 * longer exists, so it walks the extension's own storage instead — `chrome.storage.local` and the
 * IndexedDB capture store, read out through the service worker. The patterns are the ones it
 * carried, verbatim.
 */
const PATTERNS: [RegExp, string][] = [
  [/eyJ[\w-]{10,}\.[\w-]{10,}\./, 'JWT'],
  [/\b(sk|pk|rk)_(test|live|prod)?_?[A-Za-z\d]{16,}\b/, 'prefixed key'],
  [/s3ssion-fixture-value/, 'fixture session cookie'],
  [/page-state-bearer-token-value/, 'fixture page-state token'],
  [/hunter2/, 'fixture password'],
]

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'
const API_KEY = 'sk_live_51H8xKfGhIjKlMnOpQrStUv'

/** Every `.js` the build emitted; a chunk is as much part of the worker as the entry is. */
const bundleFiles = (): string[] => {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(directory, entry.name))
      else if (entry.name.endsWith('.js')) files.push(join(directory, entry.name))
    }
  }
  walk(EXTENSION)
  return files
}

/**
 * `new Function` is the wrong string to grep for, which is worth knowing before trusting this
 * check: esbuild minifies `new Function("")` down to `Function("")`, and zod reaches the
 * constructor through an alias (`const F = Function; new F("")`) that minifies the same way. So
 * the guard is on the constructor being *called* at all.
 */
const CODE_GENERATION = /\bFunction\(/g

/**
 * The one call site allowed, by the marker that identifies it: zod's JIT probe, which is wrapped
 * in a try/catch and is skipped entirely under `z.config({ jitless: true })`. Anything else — an
 * ajv swapped back in by a bundler config that resolves Node export conditions — has no such
 * marker beside it and fails the test.
 */
const KNOWN_PROBE = 'Cloudflare'

/**
 * Every row in every object store of every database the extension holds — not just the session
 * under test. The claim being made is "no credential is readable back out of extension storage",
 * and a row the sweep never opened is a row that could hold one: `sessions` and `annotations` are
 * as much of the store as `exchanges`, and a second database would be missed entirely.
 */
const wholeIndexedDb = (browser: Browser): Promise<Record<string, unknown>> =>
  browser.serviceWorker.evaluate(async () => {
    const read = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = (): void => resolve(request.result)
        request.onerror = (): void => reject(request.error ?? new Error('IndexedDB request failed'))
      })
    const dump: Record<string, unknown> = {}
    for (const { name, version } of await indexedDB.databases()) {
      if (name === undefined) continue
      const db = await read(indexedDB.open(name, version))
      for (let i = 0; i < db.objectStoreNames.length; i += 1) {
        const store = db.objectStoreNames.item(i)!
        dump[`${name}/${store}`] = await read(db.transaction(store, 'readonly').objectStore(store).getAll())
      }
      db.close()
    }
    return dump
  })

test('the built bundle generates no code', () => {
  const files = bundleFiles()
  // A guard on the build, not on the source: a Web Store reviewer reads the bundle, not the vite
  // config, and the extension's own MV3 CSP refuses whatever this would have found.
  expect(files.some((file) => file.endsWith('background.js'))).toBe(true)
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const sites = [...source.matchAll(CODE_GENERATION)]
      .map((match) => source.slice(Math.max(0, match.index - 200), match.index + 40))
      .filter((context) => !context.includes(KNOWN_PROBE))
    expect(`${file}: ${sites.length} unexpected code-generating call sites`).toBe(`${file}: 0 unexpected code-generating call sites`)
  }
})

test('nothing credential-shaped can be read back out of extension storage after a recording', async () => {
  test.setTimeout(180_000)

  const app = new FixtureApp()

  await app.start()
  await app.reset()
  const browser = await launchHelium()
  const { serviceWorker, context } = browser

  const page = await context.newPage()
  await page.goto(app.origin)
  const sessionId = await serviceWorker.evaluate((origin) => __douze.startSession('secrets', [origin]), app.origin)
  await page.waitForSelector('#create')
  await page.waitForFunction(() => (window as { __douze_interceptor__?: boolean }).__douze_interceptor__ === true)

  // One session carrying every shape the sweep looks for: a password in a request body, a
  // session cookie on every same-origin request, a page-state bearer and CSRF header, and two
  // credential-shaped values under innocuous keys that come back in the response as well.
  await page.evaluate(
    async (secrets) => {
      const auth = {
        'content-type': 'application/json',
        authorization: 'Bearer page-state-bearer-token-value',
        'x-csrf-token': 'csrf-fixture-value',
      }
      await fetch('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: 'sam', password: 'hunter2' }),
      })
      for (const note of [secrets.jwt, secrets.key]) {
        await fetch('/api/orders', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ item: 'widget', qty: 1, note }),
        })
      }
      await fetch('/api/orders', { headers: auth })
    },
    { jwt: JWT, key: API_KEY },
  )
  await waitFor(async () => (await serviceWorker.evaluate(() => __douze.badgeCount())) >= 4, 'four exchanges')
  await serviceWorker.evaluate(() => __douze.stopSession())

  const recorded = await serviceWorker.evaluate((id) => __douze.recorded(id), sessionId)
  // A vacuous sweep is worse than none: the exchanges that carried the credentials must be in
  // the store, redacted — not silently refused by the write gate and therefore absent.
  const posts = (recorded.exchanges as { method: string; url: string }[]).filter(
    (exchange) => exchange.method === 'POST' && exchange.url.endsWith('/api/orders'),
  )
  expect(posts.length).toBe(2)

  const stored = await serviceWorker.evaluate(() => chrome.storage.local.get(null))
  const indexeddb = await wholeIndexedDb(browser)
  // A sweep over nothing is worse than none: the databases have to have been opened and the
  // exchanges above have to be inside what was read.
  expect(Object.keys(indexeddb)).toContain('douze-capture/exchanges')
  const swept = JSON.stringify({ indexeddb, local: stored })
  for (const [pattern, what] of PATTERNS) {
    expect(`${what}: ${pattern.test(swept)}`).toBe(`${what}: false`)
  }
  // The redactor left a placeholder where each of those was, rather than dropping the field.
  expect(swept).toContain('«redacted:string:')
})
