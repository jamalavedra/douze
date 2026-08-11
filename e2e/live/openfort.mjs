/**
 * Live verification against a real authenticated dashboard — https://dashboard.openfort.io
 *
 * This is Part 0 of the PRD, executed for real: use the dashboard by hand, then have a tool call
 * run against the live account through the signed-in browser. Nothing here is mocked.
 *
 *   pnpm exec tsx e2e/live/openfort.mjs            # record + infer + approve + call (read-only)
 *   pnpm exec tsx e2e/live/openfort.mjs --writes   # also exercise an approved write tool
 *
 * The browser profile is persistent (DOUZE_E2E_PROFILE, default ~/.douze-e2e-profile) because
 * signing in is a manual act that must survive between runs. On the first run the script pauses
 * and waits for you to sign in; after that it reuses the session.
 */
import { chromium } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '../..')
const HELIUM = '/Applications/Helium.app/Contents/MacOS/Helium'
const TARGET = 'https://dashboard.openfort.io'
const ORIGIN = new URL(TARGET).origin
/**
 * The hosts the dashboard's own JavaScript calls. A dashboard almost never serves its own data,
 * and the relay replays inside a tab on the origin it is CALLING — so recording works without
 * these, and step 10 then fails on a tool it just recorded. The popup asks a real user for these
 * when a session ends; this build bakes them in, because there is nobody to click Allow here.
 */
const API_ORIGINS = (process.env.DOUZE_LIVE_API_ORIGINS ?? 'https://api.openfort.io')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
const PROFILE = process.env.DOUZE_E2E_PROFILE ?? join(homedir(), '.douze-e2e-profile')
const HOME = process.env.DOUZE_HOME ?? join(homedir(), '.douze-live')
const WRITES = process.argv.includes('--writes')

const log = (...args) => console.log(...args)
const step = (n, what) => log(`\n── ${n}. ${what}`)

/**
 * Waits without needing keyboard input, so the script can run unattended once the profile has a
 * session. Signing in is the only manual act, and it is detected by polling the page.
 */
async function pause(message, until, timeoutMs = 300_000) {
  log(message)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await until()) return true
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

step(1, 'Build the extension with the Openfort origins granted')
mkdirSync(HOME, { recursive: true })
mkdirSync(join(HOME, 'recipes'), { recursive: true })
mkdirSync(join(HOME, 'fixtures'), { recursive: true })
execFileSync('pnpm', ['--filter', '@douze/extension', 'build'], {
  cwd: REPO,
  env: { ...process.env, DOUZE_TEST_ORIGIN: [ORIGIN, ...API_ORIGINS].join(',') },
  stdio: 'inherit',
})

step(2, 'Start douzed')
const daemon = spawn('npx', ['tsx', join(REPO, 'packages/douzed/src/bin.ts')], {
  cwd: REPO,
  env: { ...process.env, DOUZE_HOME: HOME },
  stdio: 'inherit',
})
const runtime = await waitFor(
  () => {
    const info = JSON.parse(readFileSync(join(HOME, 'douzed.json'), 'utf8'))
    return fetch(`http://127.0.0.1:${info.port}/health`).then((r) => (r.ok ? info : null))
  },
  'douzed',
)
const token = readFileSync(join(HOME, 'token'), 'utf8').trim()
const api = (path, init = {}) =>
  fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    ...init,
    headers: { 'x-douze-token': token, 'content-type': 'application/json', ...init.headers },
  })
log(`   douzed on :${runtime.port}`)

step(3, 'Launch Helium with the persistent profile')
mkdirSync(PROFILE, { recursive: true })
const context = await chromium.launchPersistentContext(PROFILE, {
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
await worker.evaluate(([p, t]) => globalThis.__douze.connect(Number(p), String(t)), [
  String(runtime.port),
  token,
])
await waitFor(async () => ((await (await api('/health')).json()).extension_connected ? true : null), 'extension socket')
log('   extension connected to douzed')

step(4, 'Sign in to Openfort (manual, once per profile)')
const page = context.pages()[0] ?? (await context.newPage())
await page.goto(TARGET, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)

if (!(await isSignedIn(page))) {
  const ok = await pause(
    `   NOT SIGNED IN. A Helium window is open at ${TARGET}.\n` +
      '   >>> Sign in there now. This script polls every 2s and continues on its own. <<<',
    () => isSignedIn(page),
  )
  if (!ok) {
    log('   Timed out waiting for sign-in after 5 minutes. Nothing was recorded.')
    await shutdown()
  }
}
log('   signed in')

step(5, 'Record a capture session while driving the dashboard')
const sessionId = await worker.evaluate(([o]) => globalThis.__douze.startSession('openfort', [String(o)]), [ORIGIN])
log(`   session ${sessionId}`)
await page.waitForTimeout(2000)

// Drive the dashboard the way a user would: land on the app, then walk the primary nav. Each
// navigation makes the SPA call its own private JSON API, which is exactly what we capture.
await page.goto(TARGET, { waitUntil: 'networkidle' }).catch(() => {})
await page.waitForTimeout(2500)
await worker.evaluate(() => globalThis.__douze.annotate('opens the dashboard and loads the current project'))

for (const label of ['Players', 'Contracts', 'Policies', 'Settings', 'Developers', 'Overview']) {
  const link = page.locator(`a:has-text("${label}"), button:has-text("${label}")`).first()
  if (!(await link.count())) continue
  await link.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(2500)
  await worker.evaluate(([l]) => globalThis.__douze.annotate(`opens the ${l} view`), [label])
  log(`   visited ${label}`)
}

const badge = await worker.evaluate(() => globalThis.__douze.badgeCount())
const { retained } = await worker.evaluate(() => globalThis.__douze.stopSession())
log(`   captured ${badge} exchanges, retained ${retained}`)

step(6, 'Inspect what was captured')
const detail = await (await api(`/sessions/${sessionId}`)).json()
const exchanges = detail.exchanges ?? []
log(`   ${exchanges.length} exchanges persisted, ${detail.annotations?.length ?? 0} annotation spans`)
for (const e of exchanges.slice(0, 12)) log(`     ${e.method} ${new URL(e.url).pathname} -> ${e.status}`)

// TR-6 is non-negotiable: prove no credential reached disk before going further.
const serialized = JSON.stringify(detail)
const leaks = [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /sk_(live|test)_[A-Za-z0-9]{16,}/]
const leaked = leaks.filter((re) => re.test(serialized))
log(`   credential scan: ${leaked.length === 0 ? 'clean' : `LEAK -> ${leaked.join(', ')}`}`)
if (exchanges.length === 0) {
  log('\n   No exchanges captured — the dashboard made no JSON calls that passed the filter.')
  await shutdown()
}

step(7, 'Infer candidate tools from the session')
const { StudioSession, baseUrlFrom } = await import(join(REPO, 'packages/studio/src/api.ts'))
// Derived from what was captured, not from the page's own origin: the requests worth turning into
// tools go to the API host, and a recipe based at the dashboard would point every one of them at
// the wrong address. This is the same call the review UI makes.
const baseUrl = baseUrlFrom(exchanges)
log(`   base url inferred from the capture: ${baseUrl}`)
const studio = StudioSession.fromExchanges(
  { recipeName: 'openfort', baseUrl, paths: { recipes: join(HOME, 'recipes'), fixtures: join(HOME, 'fixtures') } },
  { exchanges, annotations: detail.annotations ?? [] },
)
log(`   ${studio.candidates.length} candidates:`)
for (const c of studio.candidates) {
  const t = c.tool
  log(`     ${t.side_effect.padEnd(11)} ${t.name.padEnd(28)} obs ${String(t.observations).padStart(2)}  conf ${t.confidence.toFixed(2)}`)
  log(`         ${t.description}`)
}

step(8, 'Approve candidates and write the recipe')
// AC-REC-002.3 — bulk approval is restricted to reads; a write must be approved individually.
const bulk = studio.approveReads()
log(`   bulk-approved ${bulk.approved.length} read tools; ${bulk.skipped.length} left for individual review`)
if (WRITES) {
  for (const c of studio.candidates.filter((c) => c.tool.side_effect === 'write')) {
    studio.approve(c.tool.name)
    log(`   individually approved write tool ${c.tool.name}`)
  }
}
const saved = studio.save()
log(`   wrote ${saved.path} with ${saved.fixtures.length} fixtures`)

step(9, 'Confirm the tools appear in the live registry')
const surface = await waitFor(async () => {
  const state = await (await api('/registry')).json()
  return state.tools.length > 0 ? state : null
}, 'tools in registry')
for (const t of surface.tools) log(`     ${t.qualified_name}${t.degraded ? '  [degraded: ' + t.degraded_reason + ']' : ''}`)

step(10, 'Call a read tool against the live account through the browser')
const readTool = surface.tools.find((t) => !t.degraded && t.tool.side_effect === 'read')
if (!readTool) {
  log('   no healthy read tool to call')
} else {
  const started = Date.now()
  const res = await api(`/relay/${readTool.recipe}/${readTool.tool.name}`, {
    method: 'POST',
    body: JSON.stringify({ args: {} }),
  })
  const body = await res.json()
  const ms = Date.now() - started
  log(`   ${readTool.qualified_name} -> HTTP ${body.status ?? res.status} in ${ms}ms`)
  log(`   ${JSON.stringify(body.body ?? body).slice(0, 400)}`)
}

step(11, 'Verify the same surface over a real MCP session')
const mcp = spawn('npx', ['tsx', join(REPO, 'packages/cli/src/bin.ts'), '--mcp'], {
  cwd: REPO,
  env: { ...process.env, DOUZE_HOME: HOME },
  stdio: ['pipe', 'pipe', 'inherit'],
})
const tools = await mcpToolsList(mcp)
log(`   tools/list returned ${tools.length}: ${tools.map((t) => t.name).join(', ')}`)
mcp.kill()

log('\n── Done.')
await shutdown()

async function shutdown() {
  await context.close()
  daemon.kill()
  process.exit(0)
}

async function isSignedIn(page) {
  // A signed-out Openfort dashboard lands on an auth route; a signed-in one does not.
  const url = page.url()
  if (/\/(login|signin|auth|register)/i.test(url)) return false
  const hasAuthForm = await page.locator('input[type="password"]').count()
  return hasAuthForm === 0
}

async function waitFor(fn, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function mcpToolsList(child) {
  return new Promise((resolve) => {
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      for (const line of buffer.split('\n').slice(0, -1)) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
        }
        if (message.id === 2) resolve(message.result.tools)
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
    })
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          clientInfo: { name: 'live', version: '1.0.0' },
        },
      })}\n`,
    )
  })
}
