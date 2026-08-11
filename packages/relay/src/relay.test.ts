import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
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

const call = (path: string, sid: string, id: number, init: RequestInit = {}): Promise<Response> =>
  fetch(url(path), {
    ...init,
    method: 'POST',
    headers: { 'Mcp-Session-Id': sid, ...((init.headers ?? {}) as Record<string, string>) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'orders_list' } }),
  })

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

    const res = await inflight
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'daemon_offline' })
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
