import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as RelaySocket } from 'ws'
import type { RegistryState, SurfaceTool } from '@douze/douzed'
import { REMOTE_MAX_SESSIONS, type Tool } from '@douze/shared'
import type { DaemonClient } from './daemon-client.js'
import {
  filterRemoteRegistry,
  gateResult,
  readRelayConfig,
  relayConfigPath,
  startRemoteBridge,
  websocketUrl,
  type RelayConfig,
  type RemoteBridge,
} from './remote-bridge.js'

/**
 * WO-014 T-014.2/3/4. The relay is faked at the socket — everything below it is the real bridge,
 * a real `serveMcp` instance per session, and the real secret gate.
 */

const surface = (name: string, sideEffect: Tool['side_effect']): SurfaceTool => ({
  qualified_name: `jira_${name}`,
  recipe: 'jira',
  base_url: 'https://jira.test',
  tool: {
    name,
    description: `${name} issues`,
    side_effect: sideEffect,
    confidence: 0.9,
    observations: 4,
    approved: true,
    request: { method: 'GET', path: `/${name}`, input_schema: { type: 'object', properties: {} }, headers: {} },
    response: { output_schema: {}, primary_payload_path: '$.data' },
    fixtures: [],
    flags: { sparse: false, derived_name: false, unverified: false, degraded: false, user_edited: [], suggestions: {} },
  },
  credential_source: [{ kind: 'cookie' }],
  degraded: false,
})

const state: RegistryState = {
  tools: [surface('list', 'read'), surface('create', 'write'), surface('delete', 'destructive')],
  errors: [],
  revision: 1,
}

const names = (filtered: RegistryState): string[] => filtered.tools.map((t) => t.qualified_name)

describe('filterRemoteRegistry (T-014.3)', () => {
  it('offers reads only by default', () => {
    expect(names(filterRemoteRegistry(state, { allow_writes: false }))).toEqual(['jira_list'])
  })

  it('adds writes once they are opted into', () => {
    expect(names(filterRemoteRegistry(state, { allow_writes: true }))).toEqual(['jira_list', 'jira_create'])
  })

  it('never offers a destructive tool, whatever the config says', () => {
    expect(names(filterRemoteRegistry(state, { allow_writes: true }))).not.toContain('jira_delete')
  })
})

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

const response = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: 7, result })
const calls = (): Map<string | number, string> => new Map<string | number, string>([[7, 'jira_list']])

describe('remote result gate (T-014.4)', () => {
  it('refuses a result carrying a credential and names where it is', () => {
    const gated = gateResult(response({ content: [{ type: 'text', text: `{"session":"${JWT}"}` }] }), calls(), {}) as {
      result?: unknown
      error: { code: number; message: string }
    }

    expect(gated.result).toBeUndefined()
    expect(gated.error.code).toBe(-32603)
    expect(gated.error.message).toContain('$.content[0].text')
    expect(gated.error.message).toContain('jira_list')
    expect(gated.error.message).toContain('expose')
    expect(JSON.stringify(gated)).not.toContain(JWT)
  })

  it('lets the same result through once the tool is exempted', () => {
    const message = response({ content: [{ type: 'text', text: `{"session":"${JWT}"}` }] })
    expect(gateResult(message, calls(), { expose: ['jira_list'] })).toBe(message)
  })

  it('leaves a clean result untouched', () => {
    const message = response({ content: [{ type: 'text', text: '{"issues":[{"id":"ABC-1"}]}' }] })
    expect(gateResult(message, calls(), {})).toBe(message)
  })

  it('ignores anything that is not a reply to a tools/call it saw', () => {
    const message = response({ tools: [{ name: 'jira_list' }] })
    expect(gateResult(message, new Map(), {})).toBe(message)
  })
})

describe('websocketUrl', () => {
  it('dials the relay over the scheme its own URL implies', () => {
    expect(websocketUrl('https://relay.test/')).toBe('wss://relay.test/ws')
    expect(websocketUrl('http://127.0.0.1:9000')).toBe('ws://127.0.0.1:9000/ws')
  })
})

/** One frame the fake relay received from the daemon. */
interface Frame {
  type: string
  sid?: string
  token?: string
  message?: { id?: number; result?: unknown; error?: { code: number; message: string } }
}

class FakeRelay {
  private readonly server: WebSocketServer
  private readonly frames: Frame[] = []
  socket: RelaySocket | null = null
  connections = 0

  constructor(readonly port: number = 0) {
    this.server = new WebSocketServer({ port })
    this.server.on('connection', (socket) => {
      this.connections++
      this.socket = socket
      socket.on('message', (data) => this.frames.push(JSON.parse(String(data)) as Frame))
    })
  }

  async listening(): Promise<number> {
    if (!this.server.address()) await new Promise((resolve) => this.server.once('listening', resolve))
    return (this.server.address() as { port: number }).port
  }

  send(message: unknown): void {
    this.socket?.send(JSON.stringify(message))
  }

  sendRaw(text: string): void {
    this.socket?.send(text)
  }

  /** The next frame matching `match`, consumed so a later call cannot re-read it. */
  async next(match: (frame: Frame) => boolean, timeoutMs = 8000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const index = this.frames.findIndex(match)
      if (index !== -1) return this.frames.splice(index, 1)[0]!
      await sleep(20)
    }
    throw new Error(`no matching frame within ${timeoutMs}ms; saw ${JSON.stringify(this.frames)}`)
  }

  seen(match: (frame: Frame) => boolean): boolean {
    return this.frames.some(match)
  }

  async waitForConnections(count: number, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.connections < count && Date.now() < deadline) await sleep(20)
    expect(this.connections).toBeGreaterThanOrEqual(count)
  }

  close(): void {
    this.server.close()
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const initialize = (id: number): unknown => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } },
})

const daemon = { registry: async () => state } as unknown as DaemonClient

describe('readRelayConfig (T-014.2)', () => {
  const home = mkdtempSync(join(tmpdir(), 'douze-relayconf-'))

  beforeAll(() => {
    process.env['DOUZE_HOME'] = home
  })
  afterAll(() => {
    delete process.env['DOUZE_HOME']
  })

  it('reads a pairing this daemon wrote', () => {
    const config: RelayConfig = { url: 'https://relay.test', token: 't', mcp_path: '/m/s', allow_writes: true }
    writeFileSync(relayConfigPath(), JSON.stringify(config))
    expect(readRelayConfig()).toEqual(config)
  })

  it('refuses a relay.json that is not a pairing rather than casting it', () => {
    // This file decides which tools a hosted assistant can reach; a shape nobody checked is not
    // something to carry on with.
    writeFileSync(relayConfigPath(), JSON.stringify({ url: 'https://relay.test', token: 5, allow_writes: 'yes' }))
    expect(() => readRelayConfig()).toThrow(/not a valid Douze relay pairing/)
  })

  it('is null when nothing is configured', () => {
    process.env['DOUZE_HOME'] = mkdtempSync(join(tmpdir(), 'douze-relayconf-'))
    expect(readRelayConfig()).toBeNull()
    process.env['DOUZE_HOME'] = home
  })
})

describe('remote bridge session lifecycle (T-014.2)', () => {
  let relay: FakeRelay
  let bridge: RemoteBridge
  let home: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'douze-remote-'))
    process.env['DOUZE_HOME'] = home
    relay = new FakeRelay()
    const port = await relay.listening()
    const config: RelayConfig = {
      url: `http://127.0.0.1:${port}`,
      token: 'relay-token',
      mcp_path: '/mcp/secret',
      allow_writes: false,
    }
    bridge = startRemoteBridge(daemon, config, '0.1.0')
  }, 20_000)

  afterAll(() => {
    bridge?.close()
    relay?.close()
    delete process.env['DOUZE_HOME']
  })

  it('says hello with the stored token and answers the relay’s ping', async () => {
    const hello = await relay.next((f) => f.type === 'hello')
    expect(hello).toMatchObject({ token: 'relay-token', daemon_version: '0.1.0' })

    relay.send({ type: 'welcome', heartbeat_ms: 20_000 })
    relay.send({ type: 'ping' })
    expect(await relay.next((f) => f.type === 'pong')).toBeTruthy()
  })

  it('round-trips initialize through a real MCP instance for the session', async () => {
    relay.send({ type: 'session.open', sid: 's1' })
    relay.send({ type: 'mcp.message', sid: 's1', message: initialize(1) })

    const frame = await relay.next((f) => f.type === 'mcp.message' && f.sid === 's1' && f.message?.id === 1)
    expect(frame.message?.result).toMatchObject({ serverInfo: { name: 'douze' } })
  }, 20_000)

  it('serves the session the scoped surface, not the local one (T-014.3)', async () => {
    relay.send({ type: 'mcp.message', sid: 's1', message: { jsonrpc: '2.0', id: 9, method: 'tools/list' } })

    const frame = await relay.next((f) => f.type === 'mcp.message' && f.sid === 's1' && f.message?.id === 9)
    const result = frame.message?.result as { tools: { name: string }[] } | undefined
    const tools = (result?.tools ?? []).map((t) => t.name)
    expect(tools).toEqual(['jira_list'])
  }, 20_000)

  it('drops a frame it cannot parse without taking the socket down', async () => {
    relay.send({ type: 'nonsense.frame', sid: 's1' })
    relay.sendRaw('not json at all')
    relay.send({ type: 'ping' })
    expect(await relay.next((f) => f.type === 'pong')).toBeTruthy()
  })

  it('refuses a session past the concurrency cap', async () => {
    // s1 is already open, so this fills the cap exactly, and then asks for one more.
    for (let i = 2; i <= REMOTE_MAX_SESSIONS; i++) relay.send({ type: 'session.open', sid: `s${i}` })
    relay.send({ type: 'session.open', sid: 'over' })

    expect(await relay.next((f) => f.type === 'session.closed' && f.sid === 'over')).toBeTruthy()
    // Everything inside the cap stayed open.
    expect(relay.seen((f) => f.type === 'session.closed' && f.sid !== 'over')).toBe(false)
  }, 20_000)

  it('closes a session on request', async () => {
    relay.send({ type: 'session.close', sid: 's4' })
    expect(await relay.next((f) => f.type === 'session.closed' && f.sid === 's4')).toBeTruthy()
  })

  it('tears every session down when the socket drops, and reconnects', async () => {
    relay.socket?.close()
    await relay.waitForConnections(2, 15_000)
    expect(await relay.next((f) => f.type === 'hello')).toBeTruthy()
    relay.send({ type: 'welcome', heartbeat_ms: 20_000 })

    // s1 existed before the drop; its MCP instance went with the socket.
    relay.send({ type: 'mcp.message', sid: 's1', message: initialize(2) })
    await sleep(500)
    expect(relay.seen((f) => f.type === 'mcp.message' && f.sid === 's1')).toBe(false)

    // A session opened after the reconnect still works, so it is the sessions that died, not the bridge.
    relay.send({ type: 'session.open', sid: 's6' })
    relay.send({ type: 'mcp.message', sid: 's6', message: initialize(3) })
    const frame = await relay.next((f) => f.type === 'mcp.message' && f.sid === 's6' && f.message?.id === 3)
    expect(frame.message?.result).toMatchObject({ serverInfo: { name: 'douze' } })
  }, 30_000)
})

/**
 * Its own bridge, because the registry has to be empty: the remote surface carries recipe tools
 * and nothing else, so a daemon with no approved recipes serves a session with no tools at all.
 * Found in live use against the deployed relay — the MCP SDK installs the tools handlers on the
 * first registerTool, so an empty surface used to connect with no tools capability and answer
 * `tools/list` with "Method not found" for the life of the session. Anyone who attaches a hosted
 * client before recording their first site hits exactly this.
 */
describe('a session whose registry has no approved tools yet', () => {
  let relay: FakeRelay
  let bridge: RemoteBridge

  beforeAll(async () => {
    relay = new FakeRelay()
    const port = await relay.listening()
    const empty = { registry: async () => ({ tools: [], errors: [], revision: 1 }) } as unknown as DaemonClient
    bridge = startRemoteBridge(empty, {
      url: `http://127.0.0.1:${port}`,
      token: 'relay-token',
      mcp_path: '/mcp/secret',
      allow_writes: false,
    }, '0.1.0')
    await relay.next((f) => f.type === 'hello')
    relay.send({ type: 'welcome', heartbeat_ms: 20_000 })
  }, 20_000)

  afterAll(() => {
    bridge?.close()
    relay?.close()
  })

  it('answers tools/list with an empty list rather than "Method not found"', async () => {
    relay.send({ type: 'session.open', sid: 'empty' })
    relay.send({ type: 'mcp.message', sid: 'empty', message: initialize(1) })
    const init = await relay.next((f) => f.type === 'mcp.message' && f.sid === 'empty' && f.message?.id === 1)
    // The capability has to be declared in the handshake or a client never asks in the first place.
    expect((init.message?.result as { capabilities?: { tools?: unknown } })?.capabilities?.tools).toBeTruthy()

    relay.send({ type: 'mcp.message', sid: 'empty', message: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })
    const listed = await relay.next((f) => f.type === 'mcp.message' && f.sid === 'empty' && f.message?.id === 2)
    expect(listed.message?.error).toBeUndefined()
    expect((listed.message?.result as { tools: unknown[] })?.tools).toEqual([])
  }, 20_000)
})

/**
 * Its own bridge, because the assertion is "nothing is left running", and that can only be made
 * where every session is one this test opened.
 */
describe('a repeated session.open (T-014.2)', () => {
  let relay: FakeRelay
  let bridge: RemoteBridge
  let registryCalls = 0

  beforeAll(async () => {
    relay = new FakeRelay()
    const port = await relay.listening()
    const counting = {
      registry: async () => {
        registryCalls++
        return state
      },
    } as unknown as DaemonClient
    const config: RelayConfig = {
      url: `http://127.0.0.1:${port}`,
      token: 'relay-token',
      mcp_path: '/mcp/secret',
      allow_writes: false,
    }
    bridge = startRemoteBridge(counting, config, '0.1.0')
    await relay.next((f) => f.type === 'hello')
    relay.send({ type: 'welcome', heartbeat_ms: 20_000 })
  }, 20_000)

  afterAll(() => {
    bridge?.close()
    relay?.close()
  })

  it('does not leave a second MCP instance running behind the one it kept', async () => {
    relay.send({ type: 'session.open', sid: 'a' })
    relay.send({ type: 'mcp.message', sid: 'a', message: initialize(1) })
    await relay.next((f) => f.type === 'mcp.message' && f.sid === 'a' && f.message?.id === 1)

    // The repeat used to overwrite the map entry, orphaning an instance nothing could ever close
    // — it kept polling the daemon forever, and sessions.size never moved, so the cap missed it.
    relay.send({ type: 'session.open', sid: 'a' })
    relay.send({ type: 'session.close', sid: 'a' })
    await relay.next((f) => f.type === 'session.closed' && f.sid === 'a')

    // Every session this bridge had is closed, so nothing should still be asking for a registry.
    await sleep(200)
    const settled = registryCalls
    await sleep(2500)
    expect(registryCalls).toBe(settled)
  }, 20_000)
})
