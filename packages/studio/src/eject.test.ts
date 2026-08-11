import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseRecipe, type Recipe } from '@douze/shared'
import { StudioSession } from './api.js'
import { eject } from './eject.js'
import { makeExchanges } from './testing.js'
import type { JsonSchema } from './types.js'

/**
 * The emitted package is executed for real in these tests, so it is emitted inside this package
 * where `incur` resolves. A published eject lands wherever `--out` points and installs its own.
 */
const EJECT_ROOT = join(process.cwd(), '.eject-test')
const REPO_ROOT = join(process.cwd(), '..', '..')
/** The local binary, not `npx`: every resolution round trip is a second on the wall clock. */
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx')
const FIXTURE_PORT = 4187
const BASE_URL = `http://127.0.0.1:${FIXTURE_PORT}`
const SESSION_COOKIE = 'fixture_session=s3ssion-fixture-value'

let home: string
let recipe: Recipe
let fixturesDir: string

/** Exchanges shaped exactly like `fixtures/server.ts` answers, so the emitted calls really work. */
const order = (id: number, item: string) => ({ id, item, qty: 2, status: 'open' })

function fixtureAppExchanges() {
  return makeExchanges([
    {
      url: `${BASE_URL}/api/orders`,
      response_body: { data: { orders: [order(1042, 'widget'), order(1043, 'gasket')] }, meta: { total: 2 } },
      provenance: 'List orders',
    },
    {
      url: `${BASE_URL}/api/orders`,
      response_body: { data: { orders: [order(1042, 'widget')] }, meta: { total: 1 } },
    },
    { url: `${BASE_URL}/api/orders/1042`, response_body: { data: { order: order(1042, 'widget') } } },
    { url: `${BASE_URL}/api/orders/1043`, response_body: { data: { order: order(1043, 'gasket') } } },
    {
      method: 'POST',
      url: `${BASE_URL}/api/orders`,
      request_body: { item: 'widget', qty: 2 },
      status: 201,
      response_body: { data: { order: order(1044, 'widget') } },
      provenance: 'Create order',
    },
    {
      method: 'POST',
      url: `${BASE_URL}/api/orders`,
      request_body: { item: 'gasket', qty: 1 },
      status: 201,
      response_body: { data: { order: order(1045, 'gasket') } },
    },
    { method: 'DELETE', url: `${BASE_URL}/api/orders/1044`, response_body: { data: { deleted: 1044 } } },
    { method: 'DELETE', url: `${BASE_URL}/api/orders/1045`, response_body: { data: { deleted: 1045 } } },
  ])
}

beforeAll(() => {
  rmSync(EJECT_ROOT, { recursive: true, force: true })
  home = mkdtempSync(join(tmpdir(), 'douze-eject-'))
  fixturesDir = join(home, 'fixtures')

  const studio = StudioSession.fromExchanges(
    { recipeName: 'orders-fixture', baseUrl: BASE_URL, paths: { recipes: join(home, 'recipes'), fixtures: fixturesDir } },
    { exchanges: fixtureAppExchanges() },
  )
  studio.approveReads()
  for (const candidate of studio.candidates) if (!candidate.tool.approved) studio.approve(candidate.tool.name)
  const report = studio.save()

  const parsed = parseRecipe(readFileSync(report.path, 'utf8'), 'orders-fixture.yaml')
  if (!parsed.ok || !parsed.recipe) throw new Error(parsed.error ?? 'recipe did not parse')
  recipe = parsed.recipe
})

afterAll(() => {
  rmSync(EJECT_ROOT, { recursive: true, force: true })
})

const ejectTo = (name: string) => eject({ recipe, fixturesDir, out: join(EJECT_ROOT, name) })

const readEmitted = (dir: string, file: string) => readFileSync(join(EJECT_ROOT, dir, file), 'utf8')

const emittedTools = (dir: string) => {
  const source = readEmitted(dir, 'src/tools.ts')
  const start = source.indexOf('export const TOOLS: EjectedTool[] = ')
  return JSON.parse(source.slice(start + 'export const TOOLS: EjectedTool[] = '.length)) as {
    name: string
    args_schema: JsonSchema
    options_schema: JsonSchema
    output_schema: JsonSchema
    primary_payload_path?: string
    examples: { args: Record<string, unknown>; options: Record<string, unknown>; description: string }[]
    fixture?: { response: { body: unknown } }
  }[]
}

/** Rewrites one tool's stored fixture in place, so a single named tool fails the replay. */
function corruptFixture(dir: string, tool: string): void {
  const path = join(EJECT_ROOT, dir, 'src', 'tools.ts')
  const source = readFileSync(path, 'utf8')
  const marker = 'export const TOOLS: EjectedTool[] = '
  const start = source.indexOf(marker) + marker.length
  const tools = JSON.parse(source.slice(start)) as { name: string; fixture?: { response: { body: unknown } } }[]
  const target = tools.find((t) => t.name === tool)
  const order = (target?.fixture?.response.body as { data?: { order?: Record<string, unknown> } })?.data?.order
  if (!order) throw new Error(`no fixture order to corrupt for ${tool}`)
  delete order['status']
  writeFileSync(path, `${source.slice(0, start)}${JSON.stringify(tools, null, 2)}\n`)
}

describe('AC-EJT-001 standalone package emission', () => {
  it('emits one command per approved tool and nothing for the unapproved', () => {
    const result = ejectTo('one')
    expect(result.tools).toEqual(['create_order', 'delete_order', 'get_order', 'list_orders'])
    expect(result.files).toEqual([
      'package.json',
      'tsconfig.json',
      'src/tools.ts',
      'src/execute.ts',
      'src/index.ts',
      'src/replay.ts',
    ])
  })

  // AC-EJT-001.1
  it('maps path and required parameters to args and everything else to options', () => {
    ejectTo('one')
    const tools = emittedTools('one')

    const get = tools.find((t) => t.name === 'get_order')
    expect(Object.keys((get?.args_schema['properties'] as object) ?? {})).toEqual(['orderId'])
    expect(get?.args_schema['required']).toEqual(['orderId'])
    expect(Object.keys((get?.options_schema['properties'] as object) ?? {})).toEqual(['raw'])

    const create = tools.find((t) => t.name === 'create_order')
    expect(Object.keys((create?.args_schema['properties'] as object) ?? {})).toEqual(['item', 'qty'])

    // Control flags never become positional arguments, but `confirm` stays required.
    const remove = tools.find((t) => t.name === 'delete_order')
    expect(Object.keys((remove?.args_schema['properties'] as object) ?? {})).not.toContain('confirm')
    expect(remove?.options_schema['required']).toEqual(['confirm'])
  })

  // AC-EJT-001.2
  it('declares an output schema from the response contract and an example from a fixture', () => {
    ejectTo('one')
    const tools = emittedTools('one')

    const list = tools.find((t) => t.name === 'list_orders')
    if (!list) throw new Error('no list_orders')
    expect(list.primary_payload_path).toBe('$.data.orders')
    expect(list.output_schema['type']).toBe('array')
    const items = list.output_schema['items'] as JsonSchema
    expect(Object.keys((items['properties'] as object) ?? {})).toEqual(['id', 'item', 'qty', 'status'])

    const get = tools.find((t) => t.name === 'get_order')
    expect(get?.examples).toHaveLength(1)
    // Drawn from the recorded URL, not invented from the schema.
    expect(get?.examples[0]?.args).toEqual({ orderId: '1042' })
    expect(get?.examples[0]?.description).toContain('orders-fixture/get_order.json')

    expect(tools.find((t) => t.name === 'delete_order')?.examples[0]?.options).toEqual({ confirm: true })
  })

  // AC-EJT-001.3
  it('declares incur as its only runtime dependency and imports no Douze module', () => {
    ejectTo('one')
    const manifest = JSON.parse(readEmitted('one', 'package.json')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies)).toEqual(['incur'])
    expect(manifest.devDependencies['incur']).toBeUndefined()

    for (const file of ['src/tools.ts', 'src/execute.ts', 'src/index.ts', 'src/replay.ts']) {
      const source = readEmitted('one', file)
      expect(source, file).not.toContain('@douze/')
      for (const match of source.matchAll(/^import[^']*from '([^']+)'/gm)) {
        expect(match[1], `${file} imports ${match[1] ?? ''}`).toMatch(/^(incur|node:[a-z_]+|\.\/[\w.]+\.js)$/)
      }
    }
  })

  // AC-EJT-001.4
  it('produces byte-identical output for two ejects of the same recipe', () => {
    ejectTo('a')
    ejectTo('b')
    const diff = execFileSync('diff', ['-r', join(EJECT_ROOT, 'a'), join(EJECT_ROOT, 'b')], { encoding: 'utf8' })
    expect(diff).toBe('')
  })

  it('carries no clock or randomness into the emitted source', () => {
    ejectTo('one')
    for (const file of readdirSync(join(EJECT_ROOT, 'one', 'src'))) {
      const source = readEmitted('one', join('src', file))
      expect(source, file).not.toMatch(/randomUUID|Math\.random/)
    }
    // `Date.now` is legitimate at call time for duration; it must not appear in emitted *data*.
    expect(readEmitted('one', 'src/tools.ts')).not.toContain('Date.now')
  })

  // AC-EJT-001.5
  it('writes a header naming the source recipe and its version in every file', () => {
    ejectTo('one')
    for (const file of ['tsconfig.json', 'src/tools.ts', 'src/execute.ts', 'src/index.ts', 'src/replay.ts']) {
      expect(readEmitted('one', file), file).toContain('from recipe "orders-fixture" (recipe schema version 1)')
    }
    // package.json cannot carry a comment, so the same sentence is a field.
    expect(JSON.parse(readEmitted('one', 'package.json'))['_douze']).toContain(
      'from recipe "orders-fixture" (recipe schema version 1)',
    )
  })
})

describe('AC-EJT-002.3 fixture replay tests', () => {
  const runReplay = (dir: string) => {
    try {
      return { code: 0, out: execFileSync(TSX, ['src/replay.ts'], { cwd: join(EJECT_ROOT, dir), encoding: 'utf8', input: '' }) }
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string }
      return { code: failure.status ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
    }
  }

  it('passes for every tool when the fixtures still match', () => {
    ejectTo('replay-ok')
    const result = runReplay('replay-ok')
    expect(result.out).toContain('4 fixture replays passed')
    expect(result.code).toBe(0)
  }, 60_000)

  // COV_EJT_001.2
  it('exits non-zero and names the failing tool when a fixture contradicts its schema', () => {
    ejectTo('replay-bad')
    // A fixture whose order lost its required `status` field no longer satisfies the contract.
    corruptFixture('replay-bad', 'get_order')

    const result = runReplay('replay-bad')
    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL  get_order')
    expect(result.out).toContain('fixture replays failed: get_order')
  }, 60_000)
})

describe('AC-EJT-002 ejected execution', () => {
  /**
   * Spawned, never `execFileSync`: the stub daemon below runs in this process, and a synchronous
   * child would block the event loop that has to answer it. stdin is closed because incur's
   * `serve()` reads it.
   */
  const run = (dir: string, args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(TSX, ['src/index.ts', ...args], {
        cwd: join(EJECT_ROOT, dir),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DOUZE_HOME: join(home, 'absent'), ...env },
      })
      let out = ''
      child.stdout?.on('data', (chunk) => (out += String(chunk)))
      child.stderr?.on('data', (chunk) => (out += String(chunk)))
      child.on('close', (code) => resolve({ code: code ?? 1, out }))
    })

  // AC-EJT-002.1
  it('executes through the relay when douzed is reachable', async () => {
    ejectTo('relay')
    const seen: { path: string; token: string | null; body: unknown }[] = []
    const daemon = await stubDaemon(seen)
    try {
      const result = await run('relay', ['list_orders', '--format', 'json'], {
        DOUZE_RELAY_URL: `http://127.0.0.1:${daemon.port}`,
        DOUZE_INSTALL_TOKEN: 'stub-token',
      })
      expect(result.code).toBe(0)

      expect(seen).toHaveLength(1)
      expect(seen[0]?.path).toBe('/relay/orders-fixture/list_orders')
      expect(seen[0]?.token).toBe('stub-token')
      expect(seen[0]?.body).toMatchObject({ args: {}, timeout_ms: 300000 })

      // Trimmed to the Primary Payload Path exactly as the interpreted client trims it.
      const payload = JSON.parse(result.out) as { data: { id: number }[]; notice?: string }
      expect(payload.data).toEqual([{ id: 1042, item: 'widget', qty: 2, status: 'open' }])
      expect(payload.notice).toBeUndefined()
    } finally {
      await daemon.close()
    }
  }, 60_000)

  it('does not fall back to the degraded path when the relay answers with an error', async () => {
    ejectTo('relay')
    const daemon = await stubDaemon([], { status: 400, body: { code: 'confirm_required', error: 'needs confirm=true' } })
    try {
      const result = await run('relay', ['delete_order', '1044', '--confirm'], {
        DOUZE_RELAY_URL: `http://127.0.0.1:${daemon.port}`,
        DOUZE_INSTALL_TOKEN: 'stub-token',
      })
      expect(result.code).not.toBe(0)
      expect(result.out).toContain('needs confirm=true')
      expect(result.out).not.toContain('Headless Mode')
    } finally {
      await daemon.close()
    }
  }, 60_000)

  // AC-EJT-002.2 — a real HTTP call to the real fixture app, no relay in the picture.
  it('executes directly against the target with the degraded notice when headless is configured', async () => {
    const headless: Recipe = {
      ...recipe,
      auth: { ...recipe.auth, mode: 'headless', keychain_ref: 'orders-fixture' },
    }
    eject({ recipe: headless, fixturesDir, out: join(EJECT_ROOT, 'headless') })

    const result = await run('headless', ['list_orders', '--format', 'json'], {
      DOUZE_HEADLESS_SESSION: SESSION_COOKIE,
    })
    expect(result.code).toBe(0)

    const payload = JSON.parse(result.out) as { status: number; data: { id: number }[]; notice: string }
    expect(payload.status).toBe(200)
    expect(payload.data.map((o) => o.id)).toEqual([1042, 1043])
    expect(payload.notice).toContain('Executed via Headless Mode — the degraded path')
  }, 60_000)

  it('refuses rather than falling back when neither relay nor headless is available', async () => {
    ejectTo('relay')
    const result = await run('relay', ['list_orders'])
    expect(result.code).not.toBe(0)
    expect(result.out).toContain('douzed is not reachable and Headless Mode is not enabled')
  }, 60_000)
})

/** Answers `/relay/:recipe/:tool` the way douzed does, so the relay path can be driven offline. */
async function stubDaemon(
  seen: { path: string; token: string | null; body: unknown }[],
  failure?: { status: number; body: unknown },
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += String(chunk)))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', token: req.headers['x-douze-token'] as string, body: JSON.parse(raw || '{}') })
      const answer = failure ?? {
        status: 200,
        body: {
          status: 200,
          duration_ms: 12,
          body: { data: { orders: [{ id: 1042, item: 'widget', qty: 2, status: 'open' }] }, meta: { total: 1 } },
        },
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

let fixtureApp: ChildProcess | undefined

beforeAll(async () => {
  fixtureApp = spawn(TSX, [join(REPO_ROOT, 'fixtures', 'server.ts')], {
    env: { ...process.env, FIXTURE_PORT: String(FIXTURE_PORT) },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`${BASE_URL}/__test/log`)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('fixture app did not start')
}, 30_000)

afterAll(() => {
  fixtureApp?.kill()
})
