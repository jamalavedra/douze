import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FixtureApp, Douzed, REPO, TSX, launchHelium, waitFor } from '../harness.js'
import { eject } from '../../packages/studio/src/eject.js'

/**
 * COV_EJT_001 — the escape hatch: one recipe compiled into a standalone incur package that runs
 * with no Douze install.
 *
 * TWO NOTES ON HOW THIS IS DRIVEN. First, there is no `douze eject` command to spawn — eject is
 * only reachable as a library (`packages/studio/src/eject.ts`), so it is called directly here;
 * see the report accompanying this spec. Second, the emitted package is emitted INSIDE
 * `packages/studio`, because it imports `incur` and a package in a temp directory would have no
 * `node_modules` to resolve it from. A real eject lands wherever `--out` points and installs its
 * own dependencies.
 */
const EJECT_ROOT = join(REPO, 'packages/studio/.eject-e2e')

const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    item: { type: 'string' },
    qty: { type: 'integer' },
    status: { type: 'string' },
  },
  required: ['id', 'item', 'qty', 'status'],
}

/**
 * One source of truth for the recipe: this object is handed to `eject()` and, serialized, is the
 * file douzed loads. JSON is valid YAML, so the two cannot drift into disagreeing.
 */
const RECIPE = {
  version: 1,
  name: 'orders',
  enabled: true,
  target: { base_url: 'http://127.0.0.1:4180' },
  auth: { mode: 'browser_relay', credential_source: [{ kind: 'cookie' }] },
  tools: [
    {
      name: 'list_orders',
      description: 'Lists every order.',
      side_effect: 'read',
      confidence: 0.9,
      observations: 3,
      approved: true,
      fixtures: ['orders/list_orders.json'],
      request: { method: 'GET', path: '/api/orders', headers: {}, input_schema: { type: 'object', properties: {} } },
      response: { primary_payload_path: '$.data.orders', output_schema: { type: 'array', items: ORDER_SCHEMA } },
    },
  ],
}

/** The stored fixture the emitted replay test checks against (REQ-REC-004 shape). */
const FIXTURE = {
  tool: 'list_orders',
  recorded_at: '2026-07-14T10:00:00.000Z',
  request: { method: 'GET', url: 'http://127.0.0.1:4180/api/orders', headers: {} },
  response: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      data: {
        orders: [
          { id: 1042, item: 'widget', qty: 2, status: 'open' },
          { id: 1043, item: 'gasket', qty: 1, status: 'open' },
        ],
      },
      meta: { total: 2 },
    },
  },
}

interface Run {
  code: number
  /** stdout alone: Node writes warnings to stderr, and the result has to stay parseable. */
  out: string
  /** Both streams, for assertions about what the user is shown. */
  all: string
}

test.describe('COV_EJT_001: Standalone package emission', () => {
  let app: FixtureApp
  let douzed: Douzed
  let browser: Awaited<ReturnType<typeof launchHelium>>

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    rmSync(EJECT_ROOT, { recursive: true, force: true })

    app = new FixtureApp()
    await app.start()
    await app.reset()

    douzed = new Douzed()
    mkdirSync(join(douzed.fixturesDir, 'orders'), { recursive: true })
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), JSON.stringify(RECIPE, null, 2))
    writeFileSync(join(douzed.fixturesDir, 'orders/list_orders.json'), `${JSON.stringify(FIXTURE, null, 2)}\n`)
    await douzed.start()

    browser = await launchHelium()
    await browser.serviceWorker.evaluate(
      ([port, token]) => (globalThis as never as DouzeApi).__douze.connect(Number(port), String(token)),
      [String(douzed.port), douzed.token] as const,
    )
    const page: Page = await browser.context.newPage()
    await page.goto(app.origin)
    // Sign in, exactly as the user would have before recording.
    await page.evaluate(() => fetch('/login', { method: 'POST' }).then((r) => r.json()))
    await waitFor(async () => (await (await douzed.api('/health')).json()).extension_connected, 'extension socket')
    await app.reset()

    // The recipe douzed loaded and the recipe that is ejected are the same document.
    const loaded = (await (await douzed.api('/registry')).json()) as { tools: { qualified_name: string }[] }
    expect(loaded.tools.map((t) => t.qualified_name)).toEqual(['orders_list_orders'])
  })

  test.afterAll(async () => {
    await browser?.dispose()
    douzed?.stop()
    await app?.stop()
    rmSync(EJECT_ROOT, { recursive: true, force: true })
  })

  const ejectTo = (name: string): string => {
    eject({ recipe: RECIPE as never, fixturesDir: douzed.fixturesDir, out: join(EJECT_ROOT, name) })
    return join(EJECT_ROOT, name)
  }

  /** stdin is closed because incur's `serve()` reads it; output is merged, as a user sees it. */
  const run = (cwd: string, args: string[]): Promise<Run> =>
    new Promise((resolve) => {
      const child = spawn(TSX, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DOUZE_HOME: douzed.home },
      })
      let out = ''
      let all = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk
        all += chunk
      })
      child.stderr.on('data', (chunk: Buffer) => (all += chunk))
      child.on('close', (code) => resolve({ code: code ?? 1, out, all }))
    })

  test('@COV_EJT_001.1 should emit a self-contained package that behaves like the interpreted runtime', async () => {
    test.setTimeout(180_000)

    // AC-EJT-001.4 — two ejects of the same recipe, compared file by file by a real diff.
    const first = ejectTo('first')
    const second = ejectTo('second')
    expect(execFileSync('diff', ['-r', first, second], { encoding: 'utf8' })).toBe('')

    // AC-EJT-001.3 — `incur` is the only runtime dependency.
    const manifest = JSON.parse(readFileSync(join(first, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies)).toEqual(['incur'])
    expect(manifest.devDependencies['incur']).toBeUndefined()

    // ...and no emitted file reaches back into Douze, whatever it is named.
    for (const file of readdirSync(join(first, 'src'))) {
      const source = readFileSync(join(first, 'src', file), 'utf8')
      expect(source, file).not.toContain('@douze/')
      for (const match of source.matchAll(/^import[^']*from '([^']+)'/gm)) {
        expect(match[1], `${file} imports ${match[1] ?? ''}`).toMatch(/^(incur|node:[a-z_]+|\.\/[\w.]+\.js)$/)
      }
    }

    // The emitted read command, run against the fixture app through the same relay the
    // interpreted client uses — and the interpreted client, run with the same arguments.
    const emitted = await run(first, ['src/index.ts', 'list_orders', '--format', 'json'])
    expect(emitted.code, emitted.all).toBe(0)

    const interpreted = await run(REPO, [
      join(REPO, 'packages/cli/src/bin.ts'),
      'orders',
      'list_orders',
      '--format',
      'json',
    ])
    expect(interpreted.code, interpreted.all).toBe(0)

    const fromPackage = JSON.parse(emitted.out) as { status: number; data: unknown; notice?: string }
    const fromRuntime = JSON.parse(interpreted.out) as { status: number; data: unknown }
    expect(fromPackage.data).toEqual([
      { id: 1042, item: 'widget', qty: 2, status: 'open' },
      { id: 1043, item: 'gasket', qty: 1, status: 'open' },
    ])
    // The claim that matters: same arguments, same answer, and the ejected call was not the
    // degraded path in disguise.
    expect(fromPackage.data).toEqual(fromRuntime.data)
    expect(fromPackage.status).toBe(fromRuntime.status)
    expect(fromPackage.notice).toBeUndefined()

    // Both calls really reached the target: two requests, one per client.
    expect((await app.log()).filter((r) => r.path === '/api/orders')).toHaveLength(2)
  })

  test('@COV_EJT_001.2 should exit non-zero naming the tool when a stored fixture contradicts its schema', async () => {
    test.setTimeout(180_000)

    // A healthy eject passes its own tests first, so the failure below is the fixture and not
    // the emitter.
    const healthy = ejectTo('replay-ok')
    const passing = await run(healthy, ['src/replay.ts'])
    expect(passing.code, passing.all).toBe(0)
    expect(passing.all).toContain('ok    list_orders')

    // The stored fixture loses a field its output schema declares required — exactly what a
    // drifted recording looks like on disk.
    const stored = JSON.parse(readFileSync(join(douzed.fixturesDir, 'orders/list_orders.json'), 'utf8')) as typeof FIXTURE
    delete (stored.response.body.data.orders[0] as { status?: string }).status
    writeFileSync(join(douzed.fixturesDir, 'orders/list_orders.json'), `${JSON.stringify(stored, null, 2)}\n`)

    const drifted = ejectTo('replay-bad')
    const failing = await run(drifted, ['src/replay.ts'])

    // AC-EJT-002.3 — non-zero, and it names the tool that failed rather than a count.
    expect(failing.code).toBe(1)
    expect(failing.all).toContain('FAIL  list_orders')
    expect(failing.all).toContain('fixture replays failed: list_orders')
    expect(failing.all).toMatch(/output schema/i)

    // Restore, so the fixture directory is left as the other test found it.
    writeFileSync(join(douzed.fixturesDir, 'orders/list_orders.json'), `${JSON.stringify(FIXTURE, null, 2)}\n`)
  })
})

interface DouzeApi {
  __douze: { connect(port: number, token: string): Promise<void> }
}
