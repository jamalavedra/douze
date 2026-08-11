import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { DEFAULT_PORT, DouzeError, PORT_RANGE, findSurvivingSecrets } from '@douze/shared'
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
  home = mkdtempSync(join(tmpdir(), 'douze-test-'))
  process.env['DOUZE_HOME'] = home
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
  delete process.env['DOUZE_HOME']
})

const portIsFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })

/**
 * The suite's daemon is on an explicit port; a test about port *selection* needs one that is not.
 * Swap it out and put the shared daemon back, so `afterEach` always has a live one to close.
 */
const restart = async (body: () => Promise<Daemon>): Promise<void> => {
  await daemon.close()
  rmSync(join(home, 'douzed.json'), { force: true })
  let replacement: Daemon | undefined
  try {
    replacement = await body()
  } finally {
    await replacement?.close()
    rmSync(join(home, 'douzed.json'), { force: true })
    daemon = await startDaemon({ port: 0 })
  }
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    ...init,
    headers: { 'x-douze-token': token, 'content-type': 'application/json', ...init.headers },
  })

describe('daemon lifecycle (REQ-RUN-003)', () => {
  it('refuses to start a second instance (AC-RUN-003.2)', async () => {
    await expect(startDaemon({ port: 0 })).rejects.toThrow(/already running/)
  })

  /**
   * `douze stop` reported success and the daemon kept the port: `wss.close()` leaves an
   * already-connected socket open, so `server.close()` waited on a connection that never ends.
   * With the extension attached — the normal state — the process could not be stopped at all.
   */
  it('closes even while an extension holds its WebSocket (AC-RUN-003.1)', { timeout: 15_000 }, async () => {
    await restart(async () => {
      const fresh = await startDaemon({ port: 0 })
      const socket = new WebSocket(`ws://127.0.0.1:${fresh.port}/ws?token=${encodeURIComponent(token)}`)
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve())
        socket.addEventListener('error', () => reject(new Error('socket never opened')))
      })

      // The assertion is that this returns at all. A hang here is the bug.
      await fresh.close()
      await expect(fetch(`http://127.0.0.1:${fresh.port}/health`)).rejects.toThrow()

      // `restart` closes what this returns, and closing twice must stay harmless.
      return fresh
    })
  })

  it('rejects a loopback request without the install token (AC-EXE-001.1)', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/registry`)
    expect(res.status).toBe(401)
  })

  it('binds the default port so the extension knows where to look', async ({ skip }) => {
    // Something outside this suite may already hold 8787 — a real douzed, most likely. Then this
    // says nothing; the fallback is covered by the next test either way.
    skip(!(await portIsFree(DEFAULT_PORT)), `something else is already listening on ${DEFAULT_PORT}`)
    await restart(async () => {
      const preferred = await startDaemon()
      expect(preferred.port).toBe(DEFAULT_PORT)
      return preferred
    })
  })

  it('steps to the next port the extension probes when the default is taken', async ({ skip }) => {
    // RStudio Server's default is 8787 too, and an ephemeral port would put douzed somewhere the
    // extension never looks — so the next port in the range, not just any free one.
    skip(!(await portIsFree(PORT_RANGE[1])), `something else is already listening on ${PORT_RANGE[1]}`)
    // A douzed already in the range is not a port this test can squat: the walk stops on one by
    // design rather than running a second daemon beside it, which is the next test's subject.
    skip(await douzedInRange(), 'a douzed is already running in the port range on this machine')
    const release = await hold([DEFAULT_PORT])
    try {
      await restart(async () => {
        const moved = await startDaemon()
        expect(moved.port).toBe(PORT_RANGE[1])
        return moved
      })
    } finally {
      await release()
    }
  })

  // Every port in the range is probed before it is given up on, so the degenerate case where
  // all five are held by something that is not douzed costs five probes on top of a boot.
  it(
    'falls back to an ephemeral port rather than refusing to run when the whole range is taken',
    { timeout: 15_000 },
    async ({ skip }) => {
      skip(await douzedInRange(), 'a douzed is already running in the port range on this machine')
      const release = await hold(PORT_RANGE)
    try {
        await restart(async () => {
          const last = await startDaemon()
          expect(PORT_RANGE).not.toContain(last.port)
          expect(last.port).toBeGreaterThan(0)
          return last
        })
      } finally {
        await release()
      }
    },
  )

  /**
   * RStudio Server's default is 8787 too, and it 200s on almost any path. Reading a bare 200 as
   * "a douzed already has this port" aborted startup on a port douzed had never touched — so the
   * body has to name itself, and a redirect to something that 200s does not count either.
   */
  const impostors: [string, import('node:http').RequestListener][] = [
    [
      'answers /health with its own JSON',
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"status":"ok"}')
      },
    ],
    [
      'redirects /health to a page that 200s',
      (req, res) => {
        if (req.url === '/health') {
          res.writeHead(302, { location: '/login' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true,"extension_connected":false}')
      },
    ],
  ]

  for (const [what, handler] of impostors) {
    it(`walks past a foreign service that ${what}`, async ({ skip }) => {
      skip(!(await portIsFree(DEFAULT_PORT)), `something else is already listening on ${DEFAULT_PORT}`)
      skip(!(await portIsFree(PORT_RANGE[1])), `something else is already listening on ${PORT_RANGE[1]}`)
      skip(await douzedInRange(), 'a douzed is already running in the port range on this machine')

      const impostor = createServer(handler)
      await new Promise<void>((resolve) => impostor.listen(DEFAULT_PORT, '127.0.0.1', () => resolve()))
      try {
        await restart(async () => {
          const moved = await startDaemon()
          expect(moved.port).toBe(PORT_RANGE[1])
          return moved
        })
      } finally {
        impostor.closeAllConnections()
        await new Promise((resolve) => impostor.close(resolve))
      }
    })
  }

  it('stops the walk on a port another douzed holds, rather than running a second one', async ({ skip }) => {
    // Two clients can start at the same instant and both try 8787. The loser must not step to
    // 8788 and stand up a second registry the extension will never see.
    skip(await douzedInRange(), 'a douzed is already running in the port range on this machine')
    await restart(async () => {
      const first = await startDaemon()
      rmSync(join(home, 'douzed.json'), { force: true })
      await expect(startDaemon()).rejects.toThrow(new RegExp(`already running on port ${first.port}`))
      return first
    })
  })
})

/** Whether a real douzed answers anywhere in the range — this machine's own, usually. */
const douzedInRange = async (): Promise<boolean> => {
  for (const port of PORT_RANGE) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) })).ok) return true
    } catch {
      // nothing there, or not a douzed
    }
  }
  return false
}

/**
 * Squats every named port. A port already held by something outside this suite is just as
 * occupied, so a failed bind needs no special case: either way douzed cannot have it.
 */
const hold = async (ports: readonly number[]): Promise<() => Promise<void>> => {
  const servers = ports.map(() => createServer())
  await Promise.all(
    servers.map(
      (server, index) =>
        new Promise<void>((resolve) => {
          server.once('error', () => resolve())
          server.listen(ports[index], '127.0.0.1', () => resolve())
        }),
    ),
  )
  return async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  }
}

describe('pairing (GET /pair)', () => {
  const OURS = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  const THEIRS = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba'

  const pairAt = (port: number, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/pair`, { headers })
  const pair = (headers: Record<string, string>) => pairAt(daemon.port, headers)

  it('hands the install token to the extension without a terminal', async () => {
    const res = await pair({ origin: OURS })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(OURS)
    expect(await res.json()).toMatchObject({ token, port: daemon.port })
  })

  // A page cannot forge this header, and without ACAO for its own origin it cannot read the body.
  it('refuses a web page, an unknown scheme, a malformed id, and no origin at all', async () => {
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: 'moz-extension://x' },
      { origin: 'chrome-extension://x' },
      {},
    ]) {
      const res = await pair(headers)
      expect(res.status).toBe(403)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('pins the first extension that pairs', async () => {
    expect((await pair({ origin: OURS })).status).toBe(200)
    expect(readFileSync(join(home, 'extension'), 'utf8')).toBe('abcdefghijklmnopabcdefghijklmnop')
  })

  // The reason the pin exists: any other extension with loopback host access could otherwise read
  // the token and drive the relay on every site the user approved.
  it('refuses a second extension once one is pinned', async () => {
    await pair({ origin: OURS })
    const res = await pair({ origin: THEIRS })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    // A refused attempt must not take the pin over from the extension that holds it.
    expect(readFileSync(join(home, 'extension'), 'utf8')).toBe('abcdefghijklmnopabcdefghijklmnop')
  })

  it('still pairs the same extension after a restart', async () => {
    await pair({ origin: OURS })
    await restart(async () => {
      const again = await startDaemon({ port: 0 })
      expect((await pairAt(again.port, { origin: OURS })).status).toBe(200)
      expect((await pairAt(again.port, { origin: THEIRS })).status).toBe(403)
      return again
    })
  })

  // An unpacked extension's id changes with its path, so a developer reloading a local build — and
  // the e2e suite — need a way to say which id counts without deleting the whole home.
  it('lets DOUZE_EXTENSION_ID override the pin', async () => {
    await pair({ origin: OURS })
    process.env['DOUZE_EXTENSION_ID'] = 'ponmlkjihgfedcbaponmlkjihgfedcba'
    try {
      expect((await pair({ origin: THEIRS })).status).toBe(200)
      expect((await pair({ origin: OURS })).status).toBe(403)
      // The override is not written back, so the real pin survives it.
      expect(readFileSync(join(home, 'extension'), 'utf8')).toBe('abcdefghijklmnopabcdefghijklmnop')
    } finally {
      delete process.env['DOUZE_EXTENSION_ID']
    }
  })

  // Defence in depth: a rebound name resolves to 127.0.0.1 but still arrives as Host. Raw http,
  // because fetch treats Host as a forbidden header and rewrites it from the URL.
  it('refuses a request whose Host is not loopback', async () => {
    expect(await statusWithHost('evil.example')).toBe(403)
    expect(await statusWithHost('localhost')).toBe(200)
  })

  const statusWithHost = (host: string): Promise<number | undefined> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: daemon.port, path: '/pair', headers: { host, origin: OURS } },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        },
      )
      req.on('error', reject)
      req.end()
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

describe('review served by douzed (REQ-REC-002)', () => {
  /** A capture the extension could have produced: two reads of a list and one delete. */
  const seed = (): string => {
    const session = daemon.store.startSession({ name: 'Shop orders', origins: ['https://app.example.com'] })
    const exchanges = [
      { method: 'GET', url: 'https://app.example.com/api/orders', response_body: { data: [{ id: 1, status: 'open' }] } },
      { method: 'GET', url: 'https://app.example.com/api/orders', response_body: { data: [{ id: 2, status: 'open' }] } },
      { method: 'DELETE', url: 'https://app.example.com/api/orders/1043', response_body: { data: { id: 1043 } } },
    ]
    for (const [position, exchange] of exchanges.entries()) {
      daemon.store.appendExchange({
        ...exchange,
        id: `rev-${position}`,
        session_id: session.id,
        position,
        started_at: Date.now(),
        duration_ms: 5,
        origin: 'https://app.example.com',
        status: 200,
        source: 'main_world',
      } as never)
    }
    return session.id
  }

  const state = async (id: string) =>
    (await (await api(`/api/review/${id}`)).json()) as {
      site: string
      recipe: string
      candidates: { name: string; description: string; side_effect: string }[]
    }

  const post = (path: string, body: unknown = {}) =>
    api(path, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json())

  it('serves the review page with the token inlined so its own fetches authenticate', async () => {
    const id = seed()
    const res = await api(`/review/${id}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Review your skills')
    expect(html).toContain(token)
  })

  it('describes the session in the words the page shows', async () => {
    const current = await state(seed())
    expect(current.site).toBe('app.example.com')
    expect(current.recipe).toBe('shop-orders')
    expect(current.candidates.map((c) => c.side_effect).sort()).toEqual(['destructive', 'read'])
  })

  // AC-REC-002.3 — the whole point of review: a delete is never turned on in bulk.
  it('refuses to enable a destructive tool through the bulk path', async () => {
    const id = seed()
    const current = await state(id)
    const bulk = (await post(`/api/review/${id}/enable`)) as { enabled: string[]; skipped: string[] }

    expect(bulk.enabled).toEqual([current.candidates.find((c) => c.side_effect === 'read')?.name])
    expect(bulk.skipped).toEqual([current.candidates.find((c) => c.side_effect === 'destructive')?.name])
  })

  it('enables a named destructive tool, edits it, saves, and disables it again', async () => {
    const id = seed()
    const current = await state(id)
    const destructive = current.candidates.find((c) => c.side_effect === 'destructive')?.name
    const read = current.candidates.find((c) => c.side_effect === 'read')?.name

    const enabled = (await post(`/api/review/${id}/enable`, { names: [destructive, 'no-such-tool'] })) as {
      enabled: string[]
      skipped: string[]
    }
    expect(enabled.enabled).toEqual([destructive])
    expect(enabled.skipped).toEqual(['no-such-tool'])

    await post(`/api/review/${id}/edit`, { name: read, field: 'description', value: 'Lists every order in the shop.' })
    expect((await state(id)).candidates.find((c) => c.name === read)?.description).toBe(
      'Lists every order in the shop.',
    )

    const saved = (await post(`/api/review/${id}/save`)) as { path: string; tools: string[] }
    expect(saved.tools).toEqual([destructive])
    expect(existsSync(saved.path)).toBe(true)

    await post(`/api/review/${id}/disable`, { names: [destructive] })
    expect(((await post(`/api/review/${id}/save`)) as { tools: string[] }).tools).toEqual([])
  })

  it('lists what Claude can already do on an origin, and nothing for another', async () => {
    const here = (await (await api('/api/site-tools?origin=http://127.0.0.1:4180')).json()) as {
      tools: { name: string; description: string; side_effect: string }[]
    }
    expect(here.tools).toEqual([
      { name: 'orders_list_orders', description: 'Lists every order.', side_effect: 'read' },
    ])

    const elsewhere = await (await api('/api/site-tools?origin=https://other.example')).json()
    expect(elsewhere.tools).toEqual([])
  })

  it('lets the extension popup read that list cross-origin', async () => {
    const popup = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
    const res = await fetch(
      `http://127.0.0.1:${daemon.port}/api/site-tools?origin=http://127.0.0.1:4180&token=${token}`,
      { headers: { origin: popup } },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(popup)
  })

  it('reports an unknown session rather than inventing one', async () => {
    expect((await api('/api/review/nope')).status).toBe(404)
  })

  // The extension buffers while the socket is down and drains on reconnect, so exchanges arrive
  // after review was built — for a stopped session too. A cached review would hide them for good.
  it('rebuilds the review when exchanges arrive after it was first built', async () => {
    const id = seed()
    expect((await state(id)).candidates.map((c) => c.side_effect).sort()).toEqual(['destructive', 'read'])

    daemon.store.appendExchange({
      id: 'late-0',
      session_id: id,
      position: 3,
      started_at: Date.now(),
      duration_ms: 5,
      method: 'POST',
      url: 'https://app.example.com/api/invoices',
      origin: 'https://app.example.com',
      status: 200,
      response_body: { data: { id: 7 } },
      source: 'main_world',
    } as never)

    const after = await state(id)
    expect(after.candidates.map((c) => c.side_effect).sort()).toEqual(['destructive', 'read', 'write'])
  })

  it('answers a stale review link with a page, not a JSON error about a token', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/review/${seed()}?token=not-the-one`)
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('This link has expired.')
    expect(html).toContain('record the site again')
    // Nobody chose to have a token, so nobody should have to read the word in a browser tab.
    expect(html).not.toContain('token')
  })

  it('answers a review link for an empty session with what to do about it', async () => {
    const empty = daemon.store.startSession({ name: 'Nothing here', origins: ['https://app.example.com'] })
    const res = await api(`/review/${empty.id}`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Nothing was recorded yet.')
  })

  // A caller that sent a body meant to name tools; running the bulk path for it would enable a
  // set nobody asked for.
  it('refuses an unparsable enable body instead of silently enabling every read', async () => {
    const res = await api(`/api/review/${seed()}/enable`, { method: 'POST', body: '{not json' })
    expect(res.status).toBe(400)
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

    // One hiding under an innocuous key is redacted by shape and stored too. It used to be
    // REFUSED, which cost the whole exchange — and a developer console, whose responses carry
    // API keys by design, recorded nothing while the extension counted every request.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmno'
    const stored = store.appendExchange({
      ...base,
      id: 'e2',
      position: 1,
      request_headers: { 'x-trace': jwt },
      response_body: { publishableKey: 'pk_test_4f9a2b7c1d8e3f6a0b5c' },
    } as never)

    // TR-6 is what actually matters, and it holds: neither value reaches the database.
    expect(JSON.stringify(stored)).not.toContain(jwt)
    expect(JSON.stringify(stored)).not.toContain('pk_test_')
    expect(stored.request_headers['x-trace']).toMatch(/^«redacted:/)
    expect(findSurvivingSecrets(stored)).toEqual([])
    store.close()
  })

  /**
   * `credentials[]` is supplied by the extension and is meant to hold a storage key, not a value.
   * The gate used to read only the url, headers and bodies, while the row written is the whole
   * document — so a hint carrying the token itself went to disk unread.
   */
  it('refuses an exchange whose credential hint carries the value (TR-6)', () => {
    const store = new CaptureStore(':memory:')
    const session = store.startSession({ name: 's', origins: ['https://app.test'] })
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'
    const exchange = {
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

    expect(() =>
      store.appendExchange({
        ...exchange,
        credentials: [{ header: 'authorization', expression: jwt, prefix: 'Bearer ' }],
      } as never),
    ).toThrow(/credential at/)

    // An ordinary hint — a storage lookup, no value — still stores.
    expect(() =>
      store.appendExchange({
        ...exchange,
        credentials: [
          { header: 'authorization', expression: "localStorage.getItem('access_token')", prefix: 'Bearer ' },
        ],
      } as never),
    ).not.toThrow()
    store.close()
  })

  /** The write gate stays as defence in depth: anything reaching it unredacted is still refused. */
  it('still detects a credential in a document that skipped redaction (TR-6)', () => {
    expect(findSurvivingSecrets({ trace: 'sk_live_9f8e7d6c5b4a39281706' })).toEqual(['$.trace'])
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
    // appendExchange throws by design on anything it cannot store — here a malformed exchange,
    // since a credential-shaped value is now redacted rather than refused. What is under test is
    // unchanged: a throw inside the WebSocket handler must not take the daemon down.
    expect(() =>
      daemon.store.appendExchange({
        id: 'bad',
        session_id: 'nope',
        position: 0,
        started_at: Date.now(),
        duration_ms: 1,
        // no method, no url: Exchange.parse rejects it
        status: 200,
        source: 'main_world',
      } as never),
    ).toThrow()
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
        throw new DouzeError('extension_disconnected', 'The Douze Chrome extension is not connected')
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
    // The property that matters: the key is not in the log.
    expect(audit).not.toContain('sk_live_abcdef0123456789ABCDEF')
    // It is replaced in place rather than collapsing every argument into a summary line, so the
    // trace still says which tool was called with an argument of what shape.
    expect(audit).toContain('«redacted:')
    expect(audit).toContain('list_orders')
  })
})
