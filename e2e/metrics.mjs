/**
 * PRD 1.5 success metrics and the TR-6 security sweep, measured rather than asserted.
 *
 *   ./node_modules/.bin/tsx e2e/metrics.mjs
 *
 * Answers Q4 (is relay latency acceptable?) with a number instead of the PRD's guess, and sweeps
 * every artifact Douze writes for anything credential-shaped.
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const TSX = join(REPO, 'node_modules/.bin/tsx')
const HELIUM = '/Applications/Helium.app/Contents/MacOS/Helium'
const ORIGIN = 'http://127.0.0.1:4180'

const RECIPE = `
version: 1
name: orders
enabled: true
target:
  base_url: ${ORIGIN}
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

const wait = async (fn, what, ms = 45_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      if (await fn()) return
    } catch {}
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const home = mkdtempSync(join(tmpdir(), 'douze-metrics-'))
mkdirSync(join(home, 'recipes'), { recursive: true })
mkdirSync(join(home, 'fixtures'), { recursive: true })
writeFileSync(join(home, 'recipes', 'orders.yaml'), RECIPE)
writeFileSync(join(home, 'fixtures', 'list_orders.json'), '{"data":{"orders":[]}}')

const app = spawn(TSX, [join(REPO, 'fixtures/server.ts')], { env: { ...process.env, FIXTURE_PORT: '4180' }, stdio: 'ignore' })
await wait(async () => (await fetch(`${ORIGIN}/__test/log`)).ok, 'fixture app')

const daemon = spawn(TSX, [join(REPO, 'packages/douzed/src/bin.ts')], { env: { ...process.env, DOUZE_HOME: home }, stdio: 'ignore' })
let runtime
await wait(async () => {
  runtime = JSON.parse(readFileSync(join(home, 'douzed.json'), 'utf8'))
  return (await fetch(`http://127.0.0.1:${runtime.port}/health`)).ok
}, 'douzed')
const token = readFileSync(join(home, 'token'), 'utf8').trim()
const api = (p, init = {}) =>
  fetch(`http://127.0.0.1:${runtime.port}${p}`, {
    ...init,
    headers: { 'x-douze-token': token, 'content-type': 'application/json', ...init.headers },
  })

const userDataDir = mkdtempSync(join(tmpdir(), 'douze-metrics-helium-'))
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: HELIUM,
  headless: false,
  args: [
    `--disable-extensions-except=${join(REPO, 'packages/extension/dist')}`,
    `--load-extension=${join(REPO, 'packages/extension/dist')}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
})
let [worker] = context.serviceWorkers()
worker ??= await context.waitForEvent('serviceworker', { timeout: 20_000 })
await worker.evaluate(([p, t]) => globalThis.__douze.connect(Number(p), String(t)), [String(runtime.port), token])

const page = await context.newPage()
await page.goto(ORIGIN)
await page.evaluate(() => fetch('/login', { method: 'POST' }).then((r) => r.json()))
await wait(async () => (await (await api('/health')).json()).extension_connected, 'extension socket')

// ── Q4 / PRD 1.5: relay overhead vs. a direct fetch ──────────────────────────────────────────
const N = 30
const direct = []
const relayed = []
for (let i = 0; i < N; i++) {
  let t = performance.now()
  await page.evaluate(() => fetch('/api/orders', { credentials: 'include' }).then((r) => r.json()))
  direct.push(performance.now() - t)

  t = performance.now()
  await api('/relay/orders/list_orders', { method: 'POST', body: '{"args":{}}' })
  relayed.push(performance.now() - t)
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]

console.log('\n── PRD 1.5 metrics ─────────────────────────────────────────')
console.log(`relay median            ${median(relayed).toFixed(1)} ms   (direct in-page ${median(direct).toFixed(1)} ms)`)
console.log(`relay p95               ${p95(relayed).toFixed(1)} ms`)
const overhead = median(relayed) - median(direct)
console.log(`overhead vs direct      ${overhead.toFixed(1)} ms   ${overhead < 150 ? 'PASS' : 'FAIL'} (target <150 ms)`)

// Median tool result size after trimming.
const res = await (await api('/relay/orders/list_orders', { method: 'POST', body: '{"args":{}}' })).json()
const size = Buffer.byteLength(JSON.stringify(res.body ?? {}))
console.log(`trimmed result size     ${size} B   ${size < 2048 ? 'PASS' : 'FAIL'} (target <2 KB)`)

// ── C-4 / TR-6: sweep every artifact for credential-shaped values ────────────────────────────
const PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'JWT'],
  [/\b(sk|pk|rk)_(test|live|prod)?_?[A-Za-z0-9]{16,}\b/, 'prefixed key'],
  [/s3ssion-fixture-value/, 'fixture session cookie'],
  [/page-state-bearer-token-value/, 'fixture page-state token'],
  [/hunter2/, 'fixture password'],
]
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )

console.log('\n── C-4 security sweep ──────────────────────────────────────')
let findings = 0
for (const file of walk(home)) {
  if (!existsSync(file) || statSync(file).size === 0) continue
  const text = readFileSync(file, 'latin1')
  for (const [re, label] of PATTERNS) {
    if (re.test(text)) {
      console.log(`  LEAK  ${label} in ${file.replace(home, '~')}`)
      findings += 1
    }
  }
}
console.log(`  scanned ${walk(home).length} files under DOUZE_HOME (recipes, fixtures, captures.db, audit.jsonl, token)`)
console.log(`  ${findings === 0 ? 'CLEAN — no credential-shaped value in any artifact' : `${findings} FINDING(S)`}`)

await context.close()
daemon.kill()
app.kill()
process.exit(findings === 0 && overhead < 150 ? 0 : 1)
