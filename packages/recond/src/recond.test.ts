import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReconError } from '@recon/shared'
import { startDaemon, type Daemon } from './server.js'
import { CaptureStore } from './capture-store.js'
import { installToken } from './paths.js'
import { buildRequest } from './relay.js'
import { DriftWatcher, compare } from './doctor.js'

let home: string
let daemon: Daemon
let token: string

const RECIPE = `
version: 1
name: orders
enabled: true
target:
  base_url: http://127.0.0.1:4180
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

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'recon-test-'))
  process.env['RECON_HOME'] = home
  mkdirSync(join(home, 'recipes'), { recursive: true })
  mkdirSync(join(home, 'fixtures'), { recursive: true })
  writeFileSync(join(home, 'recipes', 'orders.yaml'), RECIPE)
  writeFileSync(join(home, 'fixtures', 'list_orders.json'), '{"data":{"orders":[]}}')
  token = installToken()
  daemon = await startDaemon({ port: 0 })
})

afterEach(async () => {
  await daemon.close()
  rmSync(home, { recursive: true, force: true })
  delete process.env['RECON_HOME']
})

const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    ...init,
    headers: { 'x-recon-token': token, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

describe('daemon lifecycle (REQ-RUN-003)', () => {
  it('refuses to start a second instance (AC-RUN-003.2)', async () => {
    await expect(startDaemon({ port: 0 })).rejects.toThrow(/already running/)
  })

  it('rejects a loopback request without the install token (AC-EXE-001.1)', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/registry`)
    expect(res.status).toBe(401)
  })
})

describe('registry (REQ-RUN-001)', () => {
  it('serves approved tools namespaced by recipe (AC-RUN-001.2)', async () => {
    const state = await (await api('/registry')).json()
    expect(state.tools).toHaveLength(1)
    expect(state.tools[0].qualified_name).toBe('orders_list_orders')
  })

  it('isolates a broken recipe from the rest (AC-REC-001.4 / COV_RUN_001.1)', async () => {
    writeFileSync(join(home, 'recipes', 'broken.yaml'), 'version: 1\nname: broken\n')
    await settle(async () => (await registry()).errors.length === 1)
    const state = await registry()
    expect(state.tools).toHaveLength(1) // the good recipe still serves
    expect(state.errors[0].recipe).toBe('broken.yaml')
  })

  it('marks a tool degraded when its fixture is missing (AC-RUN-001.5 / COV_RUN_001.2)', async () => {
    rmSync(join(home, 'fixtures', 'list_orders.json'))
    writeFileSync(join(home, 'recipes', 'orders.yaml'), `${RECIPE}\n`)
    await settle(async () => (await registry()).tools[0]?.degraded === true)
    const state = await registry()
    expect(state.tools[0].degraded).toBe(true)
    expect(state.tools[0].degraded_reason).toContain('list_orders.json')
  })

  it('picks up a description edit and keeps the last valid version on bad YAML (COV_RUN_002)', async () => {
    writeFileSync(join(home, 'recipes', 'orders.yaml'), RECIPE.replace('Lists every order.', 'Edited.'))
    await settle(async () => (await registry()).tools[0]?.tool.description === 'Edited.')

    // AC-RUN-002.3 — invalid YAML must not take the recipe down.
    writeFileSync(join(home, 'recipes', 'orders.yaml'), 'version: 1\n  bad: [unclosed')
    await settle(async () => (await registry()).errors.length === 1)
    const state = await registry()
    expect(state.tools[0].tool.description).toBe('Edited.')
    expect(state.errors).toHaveLength(1)
  })
})

describe('call guards (REQ-EXE-003)', () => {
  it('reports the extension as disconnected before any network request (AC-CON-004.2)', async () => {
    const res = await api('/relay/orders/list_orders', { method: 'POST', body: '{"args":{}}' })
    const body = await res.json()
    expect(body.error).toBe('extension_disconnected')
    expect(body.message).toContain('http://127.0.0.1:4180')
  })
})

describe('request building', () => {
  it('substitutes path params and puts the rest in the query for a GET', () => {
    const request = buildRequest(
      {
        base_url: 'https://app.test',
        tool: { request: { method: 'GET', path: '/api/orders/{orderId}', input_schema: {}, headers: {} } },
      },
      { orderId: 1042, expand: 'items', confirm: true },
    )
    expect(request.url).toBe('https://app.test/api/orders/1042?expand=items')
    expect(request.body).toBeUndefined()
  })

  it('sends a GraphQL document with the caller variables (AC-INF-004.2)', () => {
    const request = buildRequest(
      {
        base_url: 'https://app.test',
        tool: {
          request: {
            method: 'POST',
            path: '/graphql',
            input_schema: {},
            headers: {},
            graphql: { operation: 'CreateIssue', document: 'mutation CreateIssue($t:String!){...}' },
          },
        },
      },
      { t: 'login bug' },
    )
    expect(request.body).toMatchObject({ operationName: 'CreateIssue', variables: { t: 'login bug' } })
  })
})

describe('capture store (REQ-CAP-005)', () => {
  it('refuses to persist an exchange carrying a credential (TR-6)', () => {
    const store = new CaptureStore(':memory:')
    const session = store.startSession({ name: 's', origins: ['https://app.test'] })
    const base = {
      id: 'e1',
      session_id: session.id,
      position: 0,
      started_at: Date.now(),
      duration_ms: 5,
      method: 'GET',
      url: 'https://app.test/api/x',
      origin: 'https://app.test',
      status: 200,
      source: 'main_world' as const,
    }
    // A credential under a *known* key is redacted and stored fine.
    expect(() => store.appendExchange({ ...base, request_headers: { authorization: 'Bearer xyz' } } as never)).not.toThrow()
    // One hiding under an innocuous key is caught by the shape gate and refused.
    expect(() =>
      store.appendExchange({
        ...base,
        id: 'e2',
        position: 1,
        request_headers: { 'x-trace': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmno' },
      } as never),
    ).toThrow(/credential/)
    store.close()
  })

  it('scopes an annotation span to the exchanges since the previous note (AC-CAP-007.2)', () => {
    const store = new CaptureStore(':memory:')
    const session = store.startSession({ name: 's', origins: ['https://app.test'] })
    const add = (position: number) =>
      store.appendExchange({
        id: `e${position}`,
        session_id: session.id,
        position,
        started_at: Date.now(),
        duration_ms: 1,
        method: 'GET',
        url: 'https://app.test/api/x',
        origin: 'https://app.test',
        status: 200,
        source: 'main_world',
      } as never)

    add(0)
    add(1)
    const first = store.annotate(session.id, 'lists orders')
    expect(first).toMatchObject({ start_position: 0, end_position: 1 })

    add(2)
    const second = store.annotate(session.id, 'transitions an issue to done')
    expect(second).toMatchObject({ start_position: 2, end_position: 2 })
    store.close()
  })
})

/**
 * The registry debounces writes, so a fixed sleep is a race under load. AC-RUN-002.1 allows
 * 5 seconds; poll until the registry reflects the edit, or give up inside that budget.
 */
const settle = async (until?: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000
  do {
    await new Promise((r) => setTimeout(r, 100))
    if (!until) continue
    if (await until()) return
  } while (Date.now() < deadline)
  if (until) throw new Error('registry did not reflect the change within 5s')
}

const registry = async (): Promise<{ tools: any[]; errors: any[] }> => (await api('/registry')).json()

describe('drift classification (REQ-DRF-001)', () => {
  it('reports ok when the shape is unchanged', () => {
    expect(compare('t', { data: { orders: [{ id: 1, status: 'open' }] } }, { data: { orders: [{ id: 9, status: 'x' }] } }))
      .toMatchObject({ status: 'ok' })
  })

  it('classifies an added optional field as schema_widened (AC-DRF-001.2 / COV_DRF_001.2)', () => {
    const report = compare('t', { order: { id: 1 } }, { order: { id: 1, priority: 'normal' } })
    expect(report.status).toBe('schema_widened')
    expect(report.added_fields).toEqual(['$.order.priority'])
  })

  it('classifies a removed required field as breaking (COV_DRF_002.1)', () => {
    const report = compare('t', { order: { id: 1, status: 'open' } }, { order: { id: 1 } })
    expect(report.status).toBe('breaking')
    expect(report.detail).toContain('$.order.status')
  })

  it('classifies a changed type as breaking', () => {
    expect(compare('t', { order: { id: 1 } }, { order: { id: 'one' } })).toMatchObject({ status: 'breaking' })
  })

  it('compares array element shape rather than length', () => {
    expect(compare('t', { xs: [{ a: 1 }] }, { xs: [{ a: 2 }, { a: 3 }] })).toMatchObject({ status: 'ok' })
  })
})

describe('doctor replay safety (AC-DRF-001.1)', () => {
  it('never replays write or destructive fixtures', async () => {
    const attempted: string[] = []
    const fakeBridge = {
      connected: true,
      call: async (surface: { qualified_name: string }) => {
        attempted.push(surface.qualified_name)
        return { id: 'x', ok: true, status: 200, headers: {}, body: { data: { orders: [] } }, duration_ms: 1, redirected_to_login: false }
      },
    }
    writeFileSync(join(home, 'fixtures', 'list_orders.json'), '{"data":{"orders":[]}}')
    writeFileSync(join(home, 'fixtures', 'delete_order.json'), '{"data":{"deleted":1}}')
    writeFileSync(
      join(home, 'recipes', 'orders.yaml'),
      `${RECIPE}
  - name: delete_order
    description: Deletes an order.
    side_effect: destructive
    confidence: 0.8
    observations: 1
    approved: true
    fixtures: [delete_order.json]
    request:
      method: DELETE
      path: /api/orders/{orderId}
      input_schema:
        type: object
        properties:
          confirm: { type: boolean }
        required: [confirm]
`,
    )
    await settle(async () => (await registry()).tools.length === 2)

    const watcher = new DriftWatcher(
      daemon.registry,
      fakeBridge as never,
      join(home, 'recipes'),
      join(home, 'fixtures'),
    )
    const report = await watcher.run('orders')

    expect(attempted).toEqual(['orders_list_orders'])
    expect(report.tools.map((t) => t.tool)).toEqual(['list_orders'])
  })
})

describe('review findings — daemon robustness', () => {
  it('survives a refused exchange instead of crashing (#4)', async () => {
    // appendExchange throws by design on a credential-shaped value; the daemon must stay up.
    expect(() =>
      daemon.store.appendExchange({
        id: 'bad',
        session_id: 'nope',
        position: 0,
        started_at: Date.now(),
        duration_ms: 1,
        method: 'GET',
        url: 'https://app.test/x',
        origin: 'https://app.test',
        status: 200,
        response_body: { trace_ref: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmno' },
        source: 'main_world',
      } as never),
    ).toThrow(/credential/)
    // The daemon is still serving.
    expect((await (await api('/health')).json()).ok).toBe(true)
  })

  it('classifies a null transition as breaking, not ok (#14a)', () => {
    expect(compare('t', { order: { id: 1 } }, { order: { id: null } })).toMatchObject({ status: 'breaking' })
    expect(compare('t', { order: { id: null } }, { order: { id: 1 } })).toMatchObject({ status: 'breaking' })
  })

  it('abandons a doctor run on a transient relay failure rather than degrading tools (#5)', async () => {
    const flaky = {
      connected: true,
      call: async () => {
        throw new ReconError('extension_disconnected', 'The Recon Chrome extension is not connected')
      },
    }
    const watcher = new DriftWatcher(daemon.registry, flaky as never, join(home, 'recipes'), join(home, 'fixtures'))
    await expect(watcher.run('orders')).rejects.toThrow(/abandoned/)

    // Critically: the recipe on disk is untouched — no tool was degraded.
    const state = await registry()
    expect(state.tools[0].degraded).toBe(false)
  })

  it('records an empty annotation span when nothing was captured since the last note (#8)', () => {
    const store = new CaptureStore(':memory:')
    const session = store.startSession({ name: 's', origins: ['https://app.test'] })
    store.appendExchange({
      id: 'e0', session_id: session.id, position: 0, started_at: Date.now(), duration_ms: 1,
      method: 'GET', url: 'https://app.test/x', origin: 'https://app.test', status: 200, source: 'main_world',
    } as never)

    expect(store.annotate(session.id, 'first')).toMatchObject({ start_position: 0, end_position: 0 })
    // Nothing new captured — the span must be empty, not claim the next exchange.
    const second = store.annotate(session.id, 'second')
    expect(second.end_position).toBeLessThan(second.start_position)
    store.close()
  })

  it('withholds a credential-shaped tool argument from the audit log (#10)', async () => {
    await api('/relay/orders/list_orders', {
      method: 'POST',
      body: JSON.stringify({ args: { note: 'sk_live_abcdef0123456789ABCDEF' } }),
    })
    const audit = readFileSync(join(home, 'audit.jsonl'), 'utf8')
    expect(audit).not.toContain('sk_live_abcdef0123456789ABCDEF')
    expect(audit).toContain('withheld')
  })
})
