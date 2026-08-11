import { connect as connectTcp } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { REMOTE_MAX_SESSIONS } from '@douze/shared'
import type { AttachedTool, HostFrame } from '@douze/mcp-host'
import { startRelay, type Relay } from './server.js'

let relay: Relay
const extensions: FakeExtension[] = []

beforeEach(async () => {
  relay = await startRelay({ port: 0 })
})

afterEach(async () => {
  for (const extension of extensions.splice(0)) extension.socket.close()
  await relay.close()
})

const url = (path: string): string => `http://127.0.0.1:${relay.port}${path}`

const enroll = async (body: Record<string, unknown> = {}): Promise<{ token: string; mcp_path: string }> => {
  const res = await fetch(url('/register'), {
    method: 'POST',
    body: JSON.stringify({ daemon_version: '0.1.0', ...body }),
  })
  expect(res.status).toBe(201)
  return res.json() as Promise<{ token: string; mcp_path: string }>
}

const tool = (name: string, description = 'List the orders on the dashboard.'): AttachedTool => ({
  name,
  description,
  input_schema: { type: 'object', properties: { tag: { type: 'string' } } },
  side_effect: 'read',
})

const SURFACE = [tool('orders_list')]

type ToolCall = Extract<HostFrame, { type: 'tool.call' }>

interface FakeExtension {
  socket: WebSocket
  /** Every frame the relay sent, in order. */
  frames: HostFrame[]
  /** Every tool.call it saw, including ones it deliberately never answered. */
  calls: ToolCall[]
}

/**
 * The stateless executor on the far side of the attachment protocol: says hello with the endpoint
 * token, pushes one surface, and answers `tool.call` frames. `run` returning undefined models a
 * worker that never answers; `pong: false` models one alive enough to hold the socket open and too
 * wedged to answer a ping.
 */
const attach = async (
  token: string,
  options: { tools?: AttachedTool[]; run?: (call: ToolCall) => unknown; pong?: boolean } = {},
): Promise<FakeExtension> => {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`)
  const extension: FakeExtension = { socket, frames: [], calls: [] }
  extensions.push(extension)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('close', (code) => reject(new Error(`closed ${code}`)))
  })
  const welcomed = new Promise<void>((resolve) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as HostFrame
      extension.frames.push(frame)
      if (frame.type === 'welcome') {
        socket.send(JSON.stringify({ type: 'surface.push', tools: options.tools ?? SURFACE }))
        resolve()
        return
      }
      if (frame.type === 'ping') {
        if (options.pong !== false) socket.send(JSON.stringify({ type: 'pong' }))
        return
      }
      if (frame.type !== 'tool.call') return
      extension.calls.push(frame)
      const answer = options.run
        ? options.run(frame)
        : { content: [{ type: 'text', text: String(frame.args['tag'] ?? 'ok') }] }
      if (answer !== undefined) socket.send(JSON.stringify({ type: 'tool.result', id: frame.id, result: answer }))
    })
  })
  socket.send(JSON.stringify({ type: 'hello', token, extension_version: '0.1.0' }))
  await welcomed
  return extension
}

const post = (path: string, body: unknown, init: RequestInit = {}): Promise<Response> =>
  fetch(url(path), { ...init, method: 'POST', body: JSON.stringify(body) })

const initialize = (path: string, init: RequestInit = {}): Promise<Response> =>
  post(path, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, init)

const open = async (path: string, init: RequestInit = {}): Promise<string> => {
  const res = await initialize(path, init)
  expect(res.status).toBe(200)
  return res.headers.get('Mcp-Session-Id') ?? ''
}

const session = (sid: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { 'Mcp-Session-Id': sid, ...((init.headers ?? {}) as Record<string, string>) },
})

const list = async (path: string, sid: string, init: RequestInit = {}): Promise<{ name: string }[]> => {
  const res = await post(path, { jsonrpc: '2.0', id: 99, method: 'tools/list' }, session(sid, init))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: { tools: { name: string }[] } }
  return body.result.tools
}

/** The surface travels on the WS socket, so a session sees it a moment after the extension connects. */
const surfaced = async (path: string, sid: string, count = 1, init: RequestInit = {}): Promise<void> => {
  await vi.waitFor(async () => expect((await list(path, sid, init)).length).toBe(count))
}

const call = (
  path: string,
  sid: string,
  id: unknown,
  args: Record<string, unknown> = {},
  init: RequestInit = {},
): Promise<Response> =>
  post(
    path,
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'orders_list', arguments: args } },
    session(sid, init),
  )

interface RpcBody {
  id: unknown
  result?: { content?: { text?: string }[] }
  error?: { code: number; message: string; data?: { error?: string; retryable?: boolean } }
}

const body = async (res: Response): Promise<RpcBody> => (await res.json()) as RpcBody

const closed = (socket: WebSocket): Promise<void> =>
  new Promise((resolve) => (socket.readyState === 3 ? resolve() : socket.once('close', () => resolve())))

describe('the round trip', () => {
  it('answers initialize itself and routes calls by the session header', async () => {
    const { token, mcp_path } = await enroll()
    const extension = await attach(token)

    const first = await initialize(mcp_path)
    const sid = first.headers.get('Mcp-Session-Id')
    expect(first.status).toBe(200)
    expect(sid).toMatch(/^[0-9a-f-]{36}$/)
    // The relay answers the handshake from the host; nothing about it reaches the extension, which
    // may well be an evicted service worker at this moment.
    expect(await body(first)).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } } },
    })
    expect(extension.frames.map((f) => f.type)).toEqual(['welcome'])

    await surfaced(mcp_path, sid ?? '')
    const answer = await call(mcp_path, sid ?? '', 2, { tag: 'called' })
    expect(answer.status).toBe(200)
    expect(await body(answer)).toMatchObject({ id: 2, result: { content: [{ text: 'called' }] } })
    // One tool.call, carrying the client's own arguments and the trust level the relay stamped.
    expect(extension.calls).toHaveLength(1)
    expect(extension.calls[0]).toMatchObject({ name: 'orders_list', args: { tag: 'called' }, trust: 'remote' })
  })

  it('answers a notification with 202 and sends the extension nothing', async () => {
    const { token, mcp_path } = await enroll()
    const extension = await attach(token)
    const sid = await open(mcp_path)

    const res = await post(mcp_path, { jsonrpc: '2.0', method: 'notifications/initialized' }, session(sid))
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
    expect(extension.calls).toHaveLength(0)
  })

  it('closes a session on DELETE and refuses it afterwards', async () => {
    const { token, mcp_path } = await enroll()
    await attach(token)
    const sid = await open(mcp_path)

    const deleted = await fetch(url(mcp_path), { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } })
    expect(deleted.status).toBe(204)
    expect((await call(mcp_path, sid, 3)).status).toBe(404)
  })

  it('refuses a server-initiated stream', async () => {
    const { token, mcp_path } = await enroll()
    await attach(token)
    expect((await fetch(url(mcp_path))).status).toBe(405)
  })

  it('reports health without authentication', async () => {
    expect(await (await fetch(url('/health'))).json()).toEqual({ ok: true })
  })
})

/**
 * The reason the relay terminates MCP at all: an MV3 worker cannot answer `initialize`, and a
 * connector added while the browser was closed must still list its tools rather than look broken.
 */
describe('the browser is closed', () => {
  it('answers initialize and tools/list with no extension attached at all', async () => {
    const { mcp_path } = await enroll()

    const res = await initialize(mcp_path)
    expect(res.status).toBe(200)
    // listChanged is declared even against an empty surface — a client that initialized here must
    // still re-read tools/list once the browser comes back.
    expect(await body(res)).toMatchObject({ result: { capabilities: { tools: { listChanged: true } } } })
    expect(await list(mcp_path, res.headers.get('Mcp-Session-Id') ?? '')).toEqual([])
  })

  it('lists the tools of an extension that has since gone away', async () => {
    const { token, mcp_path } = await enroll()
    const extension = await attach(token)
    const warm = await open(mcp_path)
    await surfaced(mcp_path, warm)

    extension.socket.close()
    await closed(extension.socket)

    // A brand new session, opened with nothing attached, is seeded from the endpoint's cache.
    const sid = await open(mcp_path)
    expect((await list(mcp_path, sid)).map((t) => t.name)).toEqual(['orders_list'])
  })

  it('answers an extension that pushed an empty surface with an empty tools/list', async () => {
    const { token, mcp_path } = await enroll()
    await attach(token, { tools: [] })
    const sid = await open(mcp_path)
    expect(await list(mcp_path, sid)).toEqual([])
  })

  it('fans a later push out to a session that already exists and records the change', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    try {
      const { token, mcp_path } = await enroll()
      const extension = await attach(token)
      const sid = await open(mcp_path)
      await surfaced(mcp_path, sid)

      extension.socket.send(
        JSON.stringify({ type: 'surface.push', tools: [tool('orders_list'), tool('orders_refund', 'Refund one.')] }),
      )
      await surfaced(mcp_path, sid, 2)
      expect((await list(mcp_path, sid)).map((t) => t.name)).toEqual(['orders_list', 'orders_refund'])
      // The session held by the client was seeded empty, then twice pushed to: two changes it must
      // be told about, and there is no stream to put them on, so they are recorded here.
      expect(lines.join('').match(/mcp\.list_changed/g)).toHaveLength(2)
    } finally {
      spy.mockRestore()
    }
  })
})

/**
 * An evicted worker takes up to the 30s `chrome.alarms` floor to come back, and nothing can wake
 * it from outside. A call that arrives in that window waits rather than reporting a browser that
 * is merely asleep as one that is gone.
 */
describe('the wake grace', () => {
  it('holds a call for a waking worker and answers it when the extension returns', async () => {
    const { token, mcp_path } = await enroll()
    const first = await attach(token)
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    first.socket.close()
    await closed(first.socket)

    const held = call(mcp_path, sid, 50, { tag: 'woken' })
    const second = await attach(token)
    const res = await held
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({ id: 50, result: { content: [{ text: 'woken' }] } })
    // It waited for the new socket rather than the old one, and was sent exactly once.
    expect(second.calls).toHaveLength(1)
    expect(first.calls).toHaveLength(0)
  })

  it('fails a call with a retryable error when the worker never returns', async () => {
    await relay.close()
    relay = await startRelay({ port: 0, wakeGraceMs: 150 })
    const { token, mcp_path } = await enroll()
    const extension = await attach(token)
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    extension.socket.close()
    await closed(extension.socket)

    const res = await call(mcp_path, sid, 51)
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({
      id: 51,
      error: {
        code: -32_000,
        message: expect.stringContaining('not connected'),
        data: { error: 'extension_disconnected', retryable: true },
      },
    })
  })

  it('never re-sends a call that was in flight when the socket dropped', async () => {
    const { token, mcp_path } = await enroll()
    // Takes the call and never answers it: it may well have run, which is exactly why nothing here
    // may retry it — a tool can be a write.
    const first = await attach(token, { run: () => undefined })
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    const inflight = call(mcp_path, sid, 52)
    await vi.waitFor(() => expect(first.calls).toHaveLength(1))
    first.socket.close()

    const res = await inflight
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({
      id: 52,
      error: { message: expect.stringContaining('never retries'), data: { retryable: true } },
    })

    const second = await attach(token, { run: () => undefined })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(second.calls).toEqual([])
    expect(first.calls).toHaveLength(1)
  })
})

describe('authentication', () => {
  it('closes a socket presenting an unknown token with 1008', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`)
    const code = await new Promise<number>((resolve) => {
      socket.once('open', () =>
        socket.send(JSON.stringify({ type: 'hello', token: 'nope', extension_version: '0.1.0' })),
      )
      socket.once('close', (value) => resolve(value))
    })
    expect(code).toBe(1008)
  })

  it('refuses rotate and delete without the endpoint token', async () => {
    const { token } = await enroll()
    expect((await fetch(url('/rotate'), { method: 'POST' })).status).toBe(401)
    expect(
      (await fetch(url('/rotate'), { method: 'POST', headers: { 'x-douze-relay-token': `${token}x` } })).status,
    ).toBe(401)
    expect((await fetch(url('/register'), { method: 'DELETE', headers: { 'x-douze-relay-token': 'x' } })).status).toBe(
      401,
    )
  })

  it('kills the old pair on rotate and serves the new one', async () => {
    const first = await enroll()
    const extension = await attach(first.token)
    const gone = new Promise<number>((resolve) => extension.socket.once('close', resolve))

    const rotated = (await (
      await fetch(url('/rotate'), { method: 'POST', headers: { 'x-douze-relay-token': first.token } })
    ).json()) as { token: string; mcp_path: string }
    expect(rotated.token).not.toBe(first.token)
    // 1008 is what tells the extension to re-hello rather than sit on a connection the relay forgot.
    expect(await gone).toBe(1008)

    expect((await initialize(first.mcp_path)).status).toBe(404)
    expect((await fetch(url('/register'), { method: 'DELETE', headers: { 'x-douze-relay-token': first.token } })).status)
      .toBe(401)

    await attach(rotated.token)
    expect((await initialize(rotated.mcp_path)).status).toBe(200)
  })

  it('drops the endpoint on delete', async () => {
    const { token, mcp_path } = await enroll()
    await attach(token)
    expect((await fetch(url('/register'), { method: 'DELETE', headers: { 'x-douze-relay-token': token } })).status).toBe(
      204,
    )
    expect((await initialize(mcp_path)).status).toBe(404)
  })

  it('requires the registered bearer token on the MCP endpoint', async () => {
    const { token, mcp_path } = await enroll({ bearer_token: 'dust-static-secret' })
    await attach(token)

    expect((await initialize(mcp_path)).status).toBe(401)
    expect((await initialize(mcp_path, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await initialize(mcp_path, { headers: { authorization: 'Bearer dust-static-secret' } })).status).toBe(200)
  })

  it('rate limits registrations from one address', async () => {
    for (let i = 0; i < 10; i++) await enroll()
    const refused = await fetch(url('/register'), { method: 'POST', body: '{}' })
    expect(refused.status).toBe(429)
  })

  /**
   * Behind a tunnel every caller shares the proxy's socket address, so charging the socket would
   * let the first user of the hour exhaust the window for everyone. Untrusted, the header must be
   * ignored just as firmly, or forging it buys a fresh bucket per request.
   */
  it('charges registrations to the forwarded caller only when the proxy is trusted', async () => {
    const enrollAs = (ip: string): Promise<Response> =>
      fetch(url('/register'), {
        method: 'POST',
        headers: { 'cf-connecting-ip': ip },
        body: JSON.stringify({ daemon_version: '0.1.0' }),
      })

    for (let i = 0; i < 10; i++) expect((await enrollAs('203.0.113.7')).status).toBe(201)
    // Untrusted: the header means nothing, so this shares the socket's exhausted bucket.
    expect((await enrollAs('198.51.100.9')).status).toBe(429)

    await relay.close()
    relay = await startRelay({ port: 0, trustProxy: true })
    for (let i = 0; i < 10; i++) expect((await enrollAs('203.0.113.7')).status).toBe(201)
    expect((await enrollAs('203.0.113.7')).status).toBe(429)
    // A different caller through the same proxy still has its own window.
    expect((await enrollAs('198.51.100.9')).status).toBe(201)
  })
})

describe('isolation and failure', () => {
  it('keeps two endpoints apart, surfaces and calls alike', async () => {
    const alpha = await enroll()
    const beta = await enroll()
    await attach(alpha.token, {
      tools: [tool('orders_list', 'alpha')],
      run: () => ({ content: [{ type: 'text', text: 'alpha' }] }),
    })
    await attach(beta.token, {
      tools: [tool('orders_list', 'beta'), tool('users_list', 'beta')],
      run: () => ({ content: [{ type: 'text', text: 'beta' }] }),
    })

    const alphaSid = await open(alpha.mcp_path)
    const betaSid = await open(beta.mcp_path)
    await surfaced(alpha.mcp_path, alphaSid, 1)
    await surfaced(beta.mcp_path, betaSid, 2)

    // One endpoint's cached surface is never visible on the other's URL.
    expect((await list(alpha.mcp_path, alphaSid)).map((t) => t.name)).toEqual(['orders_list'])
    expect((await list(beta.mcp_path, betaSid)).map((t) => t.name)).toEqual(['orders_list', 'users_list'])

    const answers = await Promise.all([
      call(alpha.mcp_path, alphaSid, 10),
      call(beta.mcp_path, betaSid, 11),
      call(alpha.mcp_path, alphaSid, 12),
      call(beta.mcp_path, betaSid, 13),
    ])
    const bodies = await Promise.all(answers.map(body))
    expect(bodies.map((b) => [b.id, b.result?.content?.[0]?.text])).toEqual([
      [10, 'alpha'],
      [11, 'beta'],
      [12, 'alpha'],
      [13, 'beta'],
    ])

    // One endpoint's session id is meaningless on the other's URL, even while both are live.
    expect((await call(beta.mcp_path, alphaSid, 14)).status).toBe(404)
  })

  it('times out a call the extension never answers', async () => {
    await relay.close()
    relay = await startRelay({ port: 0, requestTimeoutMs: 100 })
    const { token, mcp_path } = await enroll()
    await attach(token, { run: () => undefined })
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    // The extension holds the socket open and says nothing back. Without the host's timer this
    // waiter is never settled and the caller's connection hangs for as long as it is willing to.
    const res = await call(mcp_path, sid, 90)
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({
      id: 90,
      error: { code: -32_000, message: expect.stringContaining('did not answer this call in time') },
    })
  })

  it('refuses an unknown session and an oversize body', async () => {
    const { token, mcp_path } = await enroll()
    await attach(token)
    expect((await call(mcp_path, 'not-a-session', 30)).status).toBe(404)

    const huge = await fetch(url(mcp_path), {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { pad: 'x'.repeat(1_100_000) } }),
    })
    expect(huge.status).toBe(413)
  })

  it('refuses a tool nobody advertised without reaching the extension', async () => {
    const { token, mcp_path } = await enroll()
    const extension = await attach(token)
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    const res = await post(
      mcp_path,
      { jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'orders_delete' } },
      session(sid),
    )
    expect(await body(res)).toMatchObject({ id: 32, error: { code: -32_602 } })
    expect(extension.calls).toEqual([])
  })
})

describe('registration input', () => {
  it('refuses a daemon_version that would forge a log line of its own', async () => {
    const forged = '0.1.0\n2026-01-01T00:00:00.000Z endpoint.registered ep=deadbeef client=FORGED'
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    try {
      const res = await fetch(url('/register'), { method: 'POST', body: JSON.stringify({ daemon_version: forged }) })
      expect(res.status).toBe(400)
      expect(lines.join('')).not.toContain('FORGED')
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses a bearer_token that is not a string instead of failing the request', async () => {
    const res = await fetch(url('/register'), { method: 'POST', body: JSON.stringify({ bearer_token: 123 }) })
    // The unguarded version reached createHash().update(123) and answered 500 relay_failed.
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'bad_request' })
  })

  it('refuses an oversize bearer_token', async () => {
    const res = await fetch(url('/register'), {
      method: 'POST',
      body: JSON.stringify({ bearer_token: 'x'.repeat(513) }),
    })
    expect(res.status).toBe(400)
  })
})

describe('correlation', () => {
  it('refuses a second request reusing an id that is still in flight', async () => {
    const { token, mcp_path } = await enroll()
    const extension = await attach(token, { run: () => undefined })
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    const first = call(mcp_path, sid, 5)
    await vi.waitFor(() => expect(extension.calls).toHaveLength(1))

    // Without the guard the second answer could settle the first request: same session, same id.
    const second = await call(mcp_path, sid, 5)
    expect(second.status).toBe(200)
    expect(await body(second)).toMatchObject({ id: 5, error: { message: expect.stringContaining('already in flight') } })

    extension.socket.close()
    await first
  })

  it('keeps ids of different JSON types apart', async () => {
    const { token, mcp_path } = await enroll()
    await attach(token)
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    // `1` and `"1"` are two different calls. Keyed on String(id) alone the second is refused as a
    // duplicate of the first, and neither client gets what it asked for.
    const [numeric, string] = await Promise.all([
      call(mcp_path, sid, 1, { tag: 'numeric' }),
      call(mcp_path, sid, '1', { tag: 'string' }),
    ])
    expect(await body(numeric)).toMatchObject({ id: 1, result: { content: [{ text: 'numeric' }] } })
    expect(await body(string)).toMatchObject({ id: '1', result: { content: [{ text: 'string' }] } })
  })

  it('refuses the ninth call in flight and forwards the eight below it', async () => {
    const { token, mcp_path } = await enroll()
    const extension = await attach(token, { run: () => undefined })
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    const inflight = Array.from({ length: 8 }, (_, i) => call(mcp_path, sid, 100 + i))
    await vi.waitFor(() => expect(extension.calls).toHaveLength(8))

    const refused = await call(mcp_path, sid, 200)
    expect(await body(refused)).toMatchObject({ id: 200, error: { message: expect.stringContaining('in flight') } })
    // Nothing past the cap reached the extension.
    expect(extension.calls).toHaveLength(8)

    extension.socket.close()
    await Promise.all(inflight)
  })
})

describe('sessions', () => {
  it('refuses a session past the per-endpoint cap', async () => {
    const { token, mcp_path } = await enroll()
    await attach(token)
    for (let i = 0; i < REMOTE_MAX_SESSIONS; i++) expect((await initialize(mcp_path)).status).toBe(200)

    const refused = await initialize(mcp_path)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('closes the session named in the header when a client re-initializes', async () => {
    const { token, mcp_path } = await enroll()
    await attach(token)
    const first = await open(mcp_path)

    const second = await open(mcp_path, { headers: { 'Mcp-Session-Id': first } })
    expect(second).not.toBe(first)
    expect((await call(mcp_path, first, 60)).status).toBe(404)
  })

  it('expires a session left idle', async () => {
    await relay.close()
    relay = await startRelay({ port: 0, sessionIdleMs: 60 })
    const { token, mcp_path } = await enroll()
    await attach(token)
    const sid = await open(mcp_path)

    // Slept rather than polled: every request refreshes the session, so a waitFor loop would hold
    // it alive for as long as it ran and prove nothing.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await call(mcp_path, sid, 70)).status).toBe(404)
  })

  it('reaps a registration nobody ever used', async () => {
    await relay.close()
    relay = await startRelay({ port: 0, sessionIdleMs: 60 })
    const { mcp_path } = await enroll()
    // The session is served with nothing attached — that is the point — so the endpoint is only
    // nobody's once that session has idled out too.
    expect((await initialize(mcp_path)).status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect((await initialize(mcp_path)).status).toBe(404)
  })

  /**
   * The privacy half of the reaper. Every `POST /m/<secret>` refreshes `lastSeen` and holds a
   * session open, so a platform that goes on polling `tools/list` after the user uninstalled the
   * extension used to keep the endpoint — and that user's tool names, descriptions and schemas —
   * in the relay's memory indefinitely, still listing them to whoever holds the URL.
   *
   * The loop below IS the polling: each attempt refreshes the endpoint exactly as a connector
   * would, and the endpoint is reaped anyway because the clock that matters is the extension's.
   */
  it('reaps an endpoint whose extension is gone, however hard the platform keeps polling', async () => {
    await relay.close()
    relay = await startRelay({ port: 0, sessionIdleMs: 60 })
    const { token, mcp_path } = await enroll()
    const extension = await attach(token)
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    extension.socket.close()
    await vi.waitFor(
      async () => {
        const res = await post(mcp_path, { jsonrpc: '2.0', id: 99, method: 'tools/list' }, session(sid))
        // `not_found` and not `no_session`: the whole endpoint is gone, not merely its session.
        expect(await res.json()).toMatchObject({ error: 'not_found' })
      },
      { timeout: 3000, interval: 25 },
    )
  })

  /**
   * ASVS 7.3.2 — inactivity alone never expires a session a client polls every nine minutes, and
   * an MCP session is a live capability over somebody's signed-in accounts held by a party we do
   * not control. The client cost of the ceiling is one 404 and a re-`initialize`.
   */
  it('closes a session at its absolute age however busy it is kept', async () => {
    await relay.close()
    relay = await startRelay({ port: 0, sessionIdleMs: 500, sessionMaxAgeMs: 150 })
    const { token, mcp_path } = await enroll()
    await attach(token)
    const sid = await open(mcp_path)

    await vi.waitFor(
      async () => {
        const res = await post(mcp_path, { jsonrpc: '2.0', id: 99, method: 'tools/list' }, session(sid))
        // The endpoint is still live — the extension never left — so this is the session alone.
        expect(await res.json()).toMatchObject({ error: 'no_session' })
      },
      { timeout: 3000, interval: 20 },
    )
  })
})

describe('the extension socket', () => {
  it('closes a socket that never says hello', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`)
    const code = await new Promise<number>((resolve) => socket.once('close', resolve))
    expect(code).toBe(1008)
  }, 15_000)

  it('closes a socket whose first frame is not hello', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`)
    const code = await new Promise<number>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ type: 'surface.push', tools: SURFACE })))
      socket.once('close', (value) => resolve(value))
    })
    expect(code).toBe(1008)
  })

  it('replaces a previous socket when the extension redials', async () => {
    const { token, mcp_path } = await enroll()
    const first = await attach(token)
    const gone = new Promise<number>((resolve) => first.socket.once('close', resolve))

    await attach(token)
    expect(await gone).toBe(1000)
    // The endpoint is served by the new socket, not left pointing at the dead one.
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)
    expect((await body(await call(mcp_path, sid, 4))).result).toBeDefined()
  })

  it('drops a socket that stops answering pings', async () => {
    await relay.close()
    relay = await startRelay({ port: 0, heartbeatMs: 50, wakeGraceMs: 50 })
    const { token, mcp_path } = await enroll()
    await attach(token, { pong: false })
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    // Two missed pongs and the socket goes, whether or not the peer ever noticed: a half-open
    // connection is indistinguishable from a live one until something insists on an answer.
    await vi.waitFor(
      async () =>
        expect((await body(await call(mcp_path, sid, 71))).error?.data?.error).toBe('extension_disconnected'),
      { timeout: 2_000 },
    )
  })

  it('keeps its sessions when the extension reconnects', async () => {
    const { token, mcp_path } = await enroll()
    const first = await attach(token)
    const sid = await open(mcp_path)
    await surfaced(mcp_path, sid)

    first.socket.close()
    await closed(first.socket)
    // The session belongs to the relay, not to the socket: it still lists tools with nothing
    // attached, which is what a client polling a sleeping browser sees.
    expect((await list(mcp_path, sid)).map((t) => t.name)).toEqual(['orders_list'])

    await attach(token)
    const res = await call(mcp_path, sid, 91, { tag: 'still here' })
    expect(await body(res)).toMatchObject({ id: 91, result: { content: [{ text: 'still here' }] } })
  })
})

describe('HTTP semantics', () => {
  it('requires the bearer on DELETE and GET, not only on POST', async () => {
    const { token, mcp_path } = await enroll({ bearer_token: 'dust-static-secret' })
    await attach(token)
    const authorized = { authorization: 'Bearer dust-static-secret' }
    const sid = await open(mcp_path, { headers: authorized })

    const deleted = await fetch(url(mcp_path), { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } })
    expect(deleted.status).toBe(401)
    expect(deleted.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect((await fetch(url(mcp_path))).status).toBe(401)

    // The session survived the refused DELETE.
    await surfaced(mcp_path, sid, 1, { headers: authorized })
    expect((await call(mcp_path, sid, 80, {}, { headers: authorized })).status).toBe(200)
  })

  it('names the methods it accepts when refusing one', async () => {
    const { token, mcp_path } = await enroll()
    await attach(token)
    const res = await fetch(url(mcp_path), { method: 'PUT', body: '{}' })
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST, DELETE')
  })

  it('answers 413 without waiting for the rest of the upload', async () => {
    const { mcp_path } = await enroll()
    const socket = connectTcp({ port: relay.port, host: '127.0.0.1' })
    await new Promise((resolve) => socket.once('connect', resolve))

    // Promises 20MB and sends 2MB, then nothing. The version that waited for 'end' hung here and
    // read whatever else the client cared to send; this one answers at the cap and stops pulling.
    socket.write(
      `POST ${mcp_path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `Content-Length: 20000000\r\n\r\n`,
    )
    socket.write('x'.repeat(2_000_000))

    const head = await new Promise<string>((resolve) => socket.once('data', (chunk: Buffer) => resolve(String(chunk))))
    expect(head).toContain('413')
    socket.destroy()
  }, 15_000)
})

describe('the log', () => {
  /**
   * The relay now holds a whole tool surface in memory to answer tools/list, so this sweep covers
   * more than it did: a tool name or description in an operator's journal is a user's private
   * dashboard vocabulary, kept forever.
   */
  it('never carries a payload, a tool name, a description, a token, or a path secret', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    try {
      const { token, mcp_path } = await enroll({ bearer_token: 'dust-static-secret' })
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.7Xk3sVn0-secret-signature'
      await attach(token, {
        tools: [tool('billing_refund_invoice', 'Refund an invoice on the live billing dashboard.')],
        run: () => ({ content: [{ type: 'text', text: jwt }] }),
      })
      const authorized = { authorization: 'Bearer dust-static-secret' }
      const sid = await open(mcp_path, { headers: authorized })
      await surfaced(mcp_path, sid, 1, { headers: authorized })
      await post(
        mcp_path,
        { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'billing_refund_invoice' } },
        session(sid, { headers: authorized }),
      )
      await relay.close()

      const log = lines.join('')
      expect(log).toContain('extension.connected')
      expect(log).toContain('surface.pushed')
      for (const secret of [
        jwt,
        token,
        mcp_path.slice(3),
        'dust-static-secret',
        'billing_refund_invoice',
        'Refund an invoice',
        'tools/call',
        sid,
      ]) {
        expect(log).not.toContain(secret)
      }
    } finally {
      spy.mockRestore()
      // afterEach closes it again; a second close on a closed server is a no-op.
      relay = await startRelay({ port: 0 })
    }
  })

  /**
   * ASVS 16.3.1 — every refusal used to be silent. The counters existed but surfaced only in
   * `close()`, which a `Restart=always` unit killed by a signal never reaches, so an operator
   * could not see somebody guessing URL secrets or endpoint tokens at all. The line carries the
   * status and the refusal's own code and nothing the caller sent.
   */
  it('leaves a line for an authentication failure, carrying nothing that was tried', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    try {
      const guessed = 'g'.repeat(43)
      expect((await initialize(`/m/${guessed}`)).status).toBe(404)

      const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`)
      await new Promise<void>((resolve) => {
        socket.once('open', () =>
          socket.send(JSON.stringify({ type: 'hello', token: guessed, extension_version: '0.1.0' })),
        )
        socket.once('close', () => resolve())
      })

      const log = lines.join('')
      expect(log).toContain('request.refused status=404 code=not_found')
      expect(log).toContain('request.refused status=1008 code=invalid_relay_token')
      expect(log).not.toContain(guessed)
    } finally {
      spy.mockRestore()
    }
  })

  it('rate-limits the refusal lines, and says how many it swallowed', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    try {
      // A brute force is thousands of these; a line each would be a log flood rather than a record.
      for (let i = 0; i < 5; i++) expect((await initialize(`/m/${String(i).repeat(43)}`)).status).toBe(404)
      expect(lines.filter((line) => line.includes('status=404')).length).toBe(1)
      // The suppressed ones are not lost, they are carried by the next line that gets through.
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect((await initialize(`/m/${'z'.repeat(43)}`)).status).toBe(404)
      expect(lines.at(-1)).toContain('also=4')
    } finally {
      spy.mockRestore()
    }
  })
})
