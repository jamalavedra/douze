import { connect as connectTcp } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { REMOTE_MAX_SESSIONS } from '@douze/shared'
import { startRelay, type Relay } from './server.js'

let relay: Relay
const daemons: FakeDaemon[] = []

beforeEach(async () => {
  relay = await startRelay({ port: 0 })
})

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.socket.close()
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

interface FakeDaemon {
  socket: WebSocket
  /** Every frame the relay sent, in order. */
  frames: { type: string; sid?: string; message?: { id?: unknown; method?: unknown } }[]
}

/**
 * A douzed stand-in: dials in, says hello, and answers each mcp.message the way an MCP server
 * would. `reply` returning undefined models a daemon that never answers.
 */
const connect = async (
  token: string,
  reply: (message: { id?: unknown; method?: unknown }) => unknown = (m) => ({
    jsonrpc: '2.0',
    id: m.id,
    result: { ok: true },
  }),
): Promise<FakeDaemon> => {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`)
  const daemon: FakeDaemon = { socket, frames: [] }
  daemons.push(daemon)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('close', (code) => reject(new Error(`closed ${code}`)))
  })
  const welcomed = new Promise<void>((resolve) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as FakeDaemon['frames'][number]
      daemon.frames.push(frame)
      if (frame.type === 'welcome') resolve()
      if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
      if (frame.type !== 'mcp.message' || !frame.message) return
      const answer = reply(frame.message)
      if (answer !== undefined) socket.send(JSON.stringify({ type: 'mcp.message', sid: frame.sid, message: answer }))
    })
  })
  socket.send(JSON.stringify({ type: 'hello', token, daemon_version: '0.1.0' }))
  await welcomed
  return daemon
}

const initialize = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url(path), {
    ...init,
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })

const call = (path: string, sid: string, id: unknown, init: RequestInit = {}): Promise<Response> =>
  fetch(url(path), {
    ...init,
    method: 'POST',
    headers: { 'Mcp-Session-Id': sid, ...((init.headers ?? {}) as Record<string, string>) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'orders_list' } }),
  })

/** A daemon that completes the handshake and then never answers another thing. */
const mute = (m: { id?: unknown; method?: unknown }): unknown =>
  m.method === 'initialize' ? { jsonrpc: '2.0', id: m.id, result: {} } : undefined

const opened = async (path: string, token: string): Promise<{ daemon: FakeDaemon; sid: string }> => {
  const daemon = await connect(token, mute)
  return { daemon, sid: (await initialize(path)).headers.get('Mcp-Session-Id') ?? '' }
}

describe('the round trip', () => {
  it('initializes a session and routes follow-up calls by its header', async () => {
    const { token, mcp_path } = await enroll()
    await connect(token)

    const first = await initialize(mcp_path)
    const sid = first.headers.get('Mcp-Session-Id')
    expect(first.status).toBe(200)
    expect(sid).toMatch(/^[0-9a-f-]{36}$/)
    expect(await first.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    // The daemon is told to build a server instance before the first message reaches it.
    expect(daemons[0]?.frames.map((f) => f.type)).toEqual(['welcome', 'session.open', 'mcp.message'])

    const second = await call(mcp_path, sid ?? '', 2)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ id: 2 })
  })

  it('answers a notification with 202 and forwards it', async () => {
    const { token, mcp_path } = await enroll()
    const daemon = await connect(token)
    const sid = (await initialize(mcp_path)).headers.get('Mcp-Session-Id') ?? ''

    const res = await fetch(url(mcp_path), {
      method: 'POST',
      headers: { 'Mcp-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
    await vi.waitFor(() => expect(daemon.frames.filter((f) => f.type === 'mcp.message')).toHaveLength(2))
  })

  it('closes a session on DELETE and refuses it afterwards', async () => {
    const { token, mcp_path } = await enroll()
    const daemon = await connect(token)
    const sid = (await initialize(mcp_path)).headers.get('Mcp-Session-Id') ?? ''

    const closed = await fetch(url(mcp_path), { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } })
    expect(closed.status).toBe(204)
    await vi.waitFor(() => expect(daemon.frames.some((f) => f.type === 'session.close')).toBe(true))
    expect((await call(mcp_path, sid, 3)).status).toBe(404)
  })

  it('refuses a server-initiated stream', async () => {
    const { token, mcp_path } = await enroll()
    await connect(token)
    expect((await fetch(url(mcp_path))).status).toBe(405)
  })

  it('reports health without authentication', async () => {
    expect(await (await fetch(url('/health'))).json()).toEqual({ ok: true })
  })
})

describe('authentication', () => {
  it('closes a socket presenting an unknown token with 1008', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`)
    const code = await new Promise<number>((resolve) => {
      socket.once('open', () => socket.send(JSON.stringify({ type: 'hello', token: 'nope', daemon_version: '0' })))
      socket.once('close', (closed) => resolve(closed))
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
    const daemon = await connect(first.token)
    const closed = new Promise<number>((resolve) => daemon.socket.once('close', resolve))

    const rotated = (await (
      await fetch(url('/rotate'), { method: 'POST', headers: { 'x-douze-relay-token': first.token } })
    ).json()) as { token: string; mcp_path: string }
    expect(rotated.token).not.toBe(first.token)
    // 1008 is what tells the daemon to re-hello rather than sit on a connection the relay forgot.
    expect(await closed).toBe(1008)

    expect((await initialize(first.mcp_path)).status).toBe(404)
    expect((await fetch(url('/register'), { method: 'DELETE', headers: { 'x-douze-relay-token': first.token } })).status)
      .toBe(401)

    await connect(rotated.token)
    expect((await initialize(rotated.mcp_path)).status).toBe(200)
  })

  it('drops the endpoint on delete', async () => {
    const { token, mcp_path } = await enroll()
    await connect(token)
    expect((await fetch(url('/register'), { method: 'DELETE', headers: { 'x-douze-relay-token': token } })).status).toBe(
      204,
    )
    expect((await initialize(mcp_path)).status).toBe(404)
  })

  it('requires the registered bearer token on the MCP endpoint', async () => {
    const { token, mcp_path } = await enroll({ bearer_token: 'dust-static-secret' })
    await connect(token)

    expect((await initialize(mcp_path)).status).toBe(401)
    expect((await initialize(mcp_path, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await initialize(mcp_path, { headers: { authorization: 'Bearer dust-static-secret' } })).status).toBe(200)
  })

  it('rate limits registrations from one address', async () => {
    for (let i = 0; i < 10; i++) await enroll()
    const refused = await fetch(url('/register'), { method: 'POST', body: '{}' })
    expect(refused.status).toBe(429)
  })
})

describe('isolation and failure', () => {
  it('keeps two tenants apart under interleaved calls', async () => {
    const alpha = await enroll()
    const beta = await enroll()
    await connect(alpha.token, (m) => ({ jsonrpc: '2.0', id: m.id, result: { tenant: 'alpha' } }))
    await connect(beta.token, (m) => ({ jsonrpc: '2.0', id: m.id, result: { tenant: 'beta' } }))

    const alphaSid = (await initialize(alpha.mcp_path)).headers.get('Mcp-Session-Id') ?? ''
    const betaSid = (await initialize(beta.mcp_path)).headers.get('Mcp-Session-Id') ?? ''

    const answers = await Promise.all([
      call(alpha.mcp_path, alphaSid, 10),
      call(beta.mcp_path, betaSid, 11),
      call(alpha.mcp_path, alphaSid, 12),
      call(beta.mcp_path, betaSid, 13),
    ])
    const bodies = (await Promise.all(answers.map((r) => r.json()))) as { id: number; result: { tenant: string } }[]
    expect(bodies.map((b) => [b.id, b.result.tenant])).toEqual([
      [10, 'alpha'],
      [11, 'beta'],
      [12, 'alpha'],
      [13, 'beta'],
    ])

    // One tenant's session id is meaningless on the other's URL, even while both are live.
    expect((await call(beta.mcp_path, alphaSid, 14)).status).toBe(404)
  })

  it('fails an in-flight call the moment the daemon socket drops', async () => {
    const { token, mcp_path } = await enroll()
    // Answers the handshake, then goes quiet — the call is still waiting when the socket drops.
    const daemon = await connect(token, (m) =>
      m.method === 'initialize' ? { jsonrpc: '2.0', id: m.id, result: {} } : undefined,
    )
    const sid = (await initialize(mcp_path)).headers.get('Mcp-Session-Id') ?? ''

    const inflight = call(mcp_path, sid, 20)
    await vi.waitFor(() => expect(daemon.frames.filter((f) => f.type === 'mcp.message')).toHaveLength(2))
    daemon.socket.close()

    // The call carried an id, so the reason reaches the model as a JSON-RPC error rather than an
    // HTTP body no MCP client renders.
    const res = await inflight
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 20,
      error: { code: -32_000, message: expect.stringContaining('douze status') },
    })
  })

  it('refuses a call with no daemon, an unknown session, and an oversize body', async () => {
    const { token, mcp_path } = await enroll()

    const offline = await initialize(mcp_path)
    expect(offline.status).toBe(503)
    expect(await offline.json()).toMatchObject({ error: 'daemon_offline', message: expect.stringContaining('douze status') })

    await connect(token)
    expect((await call(mcp_path, 'not-a-session', 30)).status).toBe(404)

    const huge = await fetch(url(mcp_path), {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { pad: 'x'.repeat(1_100_000) } }),
    })
    expect(huge.status).toBe(413)
  })
})

describe('registration input', () => {
  it('refuses a daemon_version that would forge a log line of its own', async () => {
    const forged = '0.1.0\n2026-01-01T00:00:00.000Z endpoint.registered ep=deadbeef daemon=FORGED'
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
    const { daemon, sid } = await opened(mcp_path, token)

    const first = call(mcp_path, sid, 5)
    await vi.waitFor(() => expect(daemon.frames.filter((f) => f.type === 'mcp.message')).toHaveLength(2))

    // Without the guard this replaced the first waiter: that call hung to its 120s timeout, and
    // pending.size never grew, so the in-flight cap could not see either of them.
    const second = await call(mcp_path, sid, 5)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      id: 5,
      error: { message: expect.stringContaining('already in flight') },
    })

    daemon.socket.close()
    await first
  })

  it('keeps ids of different JSON types apart', async () => {
    const { token, mcp_path } = await enroll()
    await connect(token, (m) => ({ jsonrpc: '2.0', id: m.id, result: { typed: typeof m.id } }))
    const sid = (await initialize(mcp_path)).headers.get('Mcp-Session-Id') ?? ''

    // `1` and `"1"` are two different calls. Keyed on String(id) alone they share one waiter.
    const [numeric, string] = await Promise.all([call(mcp_path, sid, 1), call(mcp_path, sid, '1')])
    expect(await numeric.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { typed: 'number' } })
    expect(await string.json()).toEqual({ jsonrpc: '2.0', id: '1', result: { typed: 'string' } })
  })

  it('refuses the ninth call in flight and forwards the eight below it', async () => {
    const { token, mcp_path } = await enroll()
    const { daemon, sid } = await opened(mcp_path, token)

    const inflight = Array.from({ length: 8 }, (_, i) => call(mcp_path, sid, 100 + i))
    // The initialize plus all eight: none was refused below the cap.
    await vi.waitFor(() => expect(daemon.frames.filter((f) => f.type === 'mcp.message')).toHaveLength(9))

    const refused = await call(mcp_path, sid, 200)
    expect(await refused.json()).toMatchObject({
      id: 200,
      error: { message: expect.stringContaining('in flight') },
    })

    daemon.socket.close()
    await Promise.all(inflight)
  })
})

describe('sessions', () => {
  it('answers at once when the daemon refuses the session', async () => {
    const { token, mcp_path } = await enroll()
    const daemon = await connect(token, mute)
    // The daemon is already at REMOTE_MAX_SESSIONS and closes the session it was asked to open.
    daemon.socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; sid?: string }
      if (frame.type === 'session.open') daemon.socket.send(JSON.stringify({ type: 'session.closed', sid: frame.sid }))
    })

    // Without rejecting the session's waiters this sat on the initialize for the full 120s.
    const res = await initialize(mcp_path)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'session_refused' })
  })

  it('refuses a session past the per-endpoint cap', async () => {
    const { token, mcp_path } = await enroll()
    await connect(token)
    for (let i = 0; i < REMOTE_MAX_SESSIONS; i++) expect((await initialize(mcp_path)).status).toBe(200)

    const refused = await initialize(mcp_path)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('closes the session named in the header when a client re-initializes', async () => {
    const { token, mcp_path } = await enroll()
    const daemon = await connect(token)
    const first = (await initialize(mcp_path)).headers.get('Mcp-Session-Id') ?? ''

    const second = (await initialize(mcp_path, { headers: { 'Mcp-Session-Id': first } })).headers.get('Mcp-Session-Id')
    expect(second).not.toBe(first)
    await vi.waitFor(() => expect(daemon.frames.some((f) => f.type === 'session.close' && f.sid === first)).toBe(true))
    expect((await call(mcp_path, first, 60)).status).toBe(404)
  })

  it('expires a session left idle and tells the daemon to drop its instance', async () => {
    await relay.close()
    relay = await startRelay({ port: 0, sessionIdleMs: 60 })
    const { token, mcp_path } = await enroll()
    const daemon = await connect(token)
    const sid = (await initialize(mcp_path)).headers.get('Mcp-Session-Id') ?? ''

    await vi.waitFor(() => expect(daemon.frames.some((f) => f.type === 'session.close' && f.sid === sid)).toBe(true))
    expect((await call(mcp_path, sid, 70)).status).toBe(404)
  })

  it('reaps a registration whose daemon never dialled in', async () => {
    await relay.close()
    relay = await startRelay({ port: 0, sessionIdleMs: 60 })
    const { mcp_path } = await enroll()
    expect((await initialize(mcp_path)).status).toBe(503)

    // No socket and no session for two idle windows, and — because a request refreshes the
    // endpoint — nobody asking for it either. Then it is gone, not merely quiet.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect((await initialize(mcp_path)).status).toBe(404)
  })
})

describe('the daemon socket', () => {
  it('closes a socket that never says hello', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`)
    const code = await new Promise<number>((resolve) => socket.once('close', resolve))
    expect(code).toBe(1008)
  }, 15_000)

  it('replaces a previous socket when the daemon redials', async () => {
    const { token, mcp_path } = await enroll()
    const first = await connect(token)
    const closed = new Promise<number>((resolve) => first.socket.once('close', resolve))

    await connect(token)
    expect(await closed).toBe(1000)
    // The endpoint is served by the new socket, not left pointing at the dead one.
    expect((await initialize(mcp_path)).status).toBe(200)
  })
})

describe('HTTP semantics', () => {
  it('requires the bearer on DELETE and GET, not only on POST', async () => {
    const { token, mcp_path } = await enroll({ bearer_token: 'dust-static-secret' })
    await connect(token)
    const authorized = { authorization: 'Bearer dust-static-secret' }
    const sid = (await initialize(mcp_path, { headers: authorized })).headers.get('Mcp-Session-Id') ?? ''

    const deleted = await fetch(url(mcp_path), { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } })
    expect(deleted.status).toBe(401)
    expect(deleted.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect((await fetch(url(mcp_path))).status).toBe(401)

    // The session survived the refused DELETE.
    expect((await call(mcp_path, sid, 80, { headers: authorized })).status).toBe(200)
  })

  it('names the methods it accepts when refusing one', async () => {
    const { token, mcp_path } = await enroll()
    await connect(token)
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
  it('never carries a payload, a token, or a path secret', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    try {
      const { token, mcp_path } = await enroll({ bearer_token: 'dust-static-secret' })
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.7Xk3sVn0-secret-signature'
      await connect(token, (m) => ({ jsonrpc: '2.0', id: m.id, result: { session: jwt } }))
      const sid =
        (await initialize(mcp_path, { headers: { authorization: 'Bearer dust-static-secret' } })).headers.get(
          'Mcp-Session-Id',
        ) ?? ''
      await call(mcp_path, sid, 40, { headers: { authorization: 'Bearer dust-static-secret' } })
      await relay.close()

      const log = lines.join('')
      expect(log).toContain('daemon.connected')
      for (const secret of [jwt, token, mcp_path.slice(3), 'dust-static-secret', 'tools/call', sid]) {
        expect(log).not.toContain(secret)
      }
    } finally {
      spy.mockRestore()
      // afterEach closes it again; a second close on a closed server is a no-op.
      relay = await startRelay({ port: 0 })
    }
  })
})
