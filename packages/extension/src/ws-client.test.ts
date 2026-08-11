import { describe, expect, it } from 'vitest'
import { ClientMessage, HEARTBEAT_MS, type Exchange } from '@douze/shared'
import { Outbox, backoffDelay, socketUrl } from './ws-client.js'

const exchange = (id: string): Exchange => ({
  id,
  session_id: 's1',
  position: 0,
  started_at: 1,
  duration_ms: 1,
  method: 'GET',
  url: 'https://app.example/api/orders',
  origin: 'https://app.example',
  request_headers: {},
  status: 200,
  response_headers: {},
  body_missing: false,
  background: true,
  source: 'main_world',
  credentials: [],
})

describe('socketUrl', () => {
  it('dials 127.0.0.1 with the install token, never localhost', () => {
    expect(socketUrl(8787, 'tok en/+')).toBe('ws://127.0.0.1:8787/ws?token=tok%20en%2F%2B')
  })
})

describe('backoffDelay', () => {
  it('grows the window exponentially and caps it', () => {
    const max = (attempt: number): number => backoffDelay(attempt, () => 0.999_999)
    expect(max(0)).toBe(999)
    expect(max(1)).toBe(1999)
    expect(max(5)).toBe(29_999)
    expect(max(50)).toBe(29_999)
  })

  it('uses full jitter, so the floor is zero at every attempt', () => {
    expect(backoffDelay(4, () => 0)).toBe(0)
  })
})

describe('Outbox', () => {
  it('replays buffered messages in order once the socket accepts them', () => {
    const outbox = new Outbox()
    outbox.push({ type: 'exchange.append', exchange: exchange('a') })
    outbox.push({ type: 'exchange.append', exchange: exchange('b') })
    const sent: ClientMessage[] = []
    expect(outbox.drain((m) => (sent.push(m), true))).toBe(2)
    expect(sent.map((m) => (m.type === 'exchange.append' ? m.exchange.id : ''))).toEqual(['a', 'b'])
    expect(outbox.size).toBe(0)
  })

  it('leaves the remainder queued in order when the socket refuses', () => {
    const outbox = new Outbox()
    outbox.push({ type: 'exchange.append', exchange: exchange('a') })
    outbox.push({ type: 'exchange.append', exchange: exchange('b') })
    let accepted = 0
    expect(outbox.drain(() => accepted++ < 1)).toBe(1)
    expect(outbox.size).toBe(1)
    const [remaining] = outbox.snapshot()
    expect(remaining?.type === 'exchange.append' && remaining.exchange.id).toBe('b')
  })

  /**
   * The queue lives in a service worker Chrome suspends after 30 seconds idle, and a socket that
   * is down is exactly when nothing keeps the worker awake. Memory-only, the buffer that exists to
   * survive a stopped daemon was the first thing lost to one.
   */
  it('resumes a queue buffered by a worker Chrome has since suspended', () => {
    const before = new Outbox()
    let persisted: ClientMessage[] = []
    before.onChange = (messages) => {
      persisted = messages
    }
    before.push({ type: 'exchange.append', exchange: exchange('a') })
    before.push({ type: 'exchange.append', exchange: exchange('b') })
    expect(persisted).toHaveLength(2)

    // The worker dies and Chrome respawns it; all the new one has is what was written.
    const after = new Outbox()
    after.restore(JSON.parse(JSON.stringify(persisted)) as ClientMessage[])
    after.push({ type: 'exchange.append', exchange: exchange('c') })

    const sent: ClientMessage[] = []
    expect(after.drain((m) => (sent.push(m), true))).toBe(3)
    expect(sent.map((m) => (m.type === 'exchange.append' ? m.exchange.id : ''))).toEqual(['a', 'b', 'c'])
    expect(persisted).toHaveLength(2)
  })

  it('rewrites what it persists as it drains, so a delivered exchange is not replayed', () => {
    const outbox = new Outbox()
    let persisted: ClientMessage[] = []
    outbox.onChange = (messages) => {
      persisted = messages
    }
    outbox.push({ type: 'exchange.append', exchange: exchange('a') })
    outbox.push({ type: 'exchange.append', exchange: exchange('b') })
    let accepted = 0
    outbox.drain(() => accepted++ < 1)
    expect(persisted.map((m) => (m.type === 'exchange.append' ? m.exchange.id : ''))).toEqual(['b'])
  })

  it('drops the oldest entries rather than growing without bound', () => {
    const outbox = new Outbox(2)
    for (const id of ['a', 'b', 'c']) outbox.push({ type: 'exchange.append', exchange: exchange(id) })
    expect(outbox.size).toBe(2)
    const first = outbox.snapshot()[0]
    expect(first?.type === 'exchange.append' && first.exchange.id).toBe('b')
  })
})

describe('message framing', () => {
  it('speaks exactly the shapes douzed validates', () => {
    const messages: ClientMessage[] = [
      { type: 'hello', token: 't', extension_version: '0.1.0' },
      { type: 'pong' },
      { type: 'exchange.append', exchange: exchange('a') },
      {
        type: 'exchange.session.start',
        session: {
          id: 's1',
          name: 'orders',
          origins: ['https://app.example'],
          started_at: 1,
          debugger_enabled: false,
        },
      },
      { type: 'exchange.session.stop', session_id: 's1', retained: 2 },
      { type: 'exchange.annotate', span: { id: 'a1', session_id: 's1', note: 'n', start_position: 0, end_position: 1 } },
      {
        type: 'relay.response',
        id: 'r1',
        response: { id: 'r1', ok: true, status: 200, headers: {}, duration_ms: 5, redirected_to_login: false },
      },
    ]
    for (const message of messages) {
      expect(ClientMessage.safeParse(JSON.parse(JSON.stringify(message))).success, message.type).toBe(true)
    }
  })

  it('pings inside Chrome’s 30-second idle window', () => {
    expect(HEARTBEAT_MS).toBeLessThan(30_000)
  })
})
