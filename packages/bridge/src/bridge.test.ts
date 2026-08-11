import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { AttachedTool, HostFrame } from '@douze/mcp-host'
import { startBridge, type Bridge, type BridgeOptions } from './bridge.js'
import { credentialFile } from './pairing.js'

/**
 * Both ends of the bridge are faked here, because both ends are the whole package: a fake MCP
 * client on the stdio pair and a fake extension on the loopback socket. Everything in between is
 * the real `McpHost`, the real WebSocket server and the real pairing file.
 */

let home: string
const bridges: Bridge[] = []
const sockets: WebSocket[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'douze-bridge-'))
  process.env['DOUZE_HOME'] = home
})

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  for (const bridge of bridges.splice(0)) await bridge.close()
  delete process.env['DOUZE_HOME']
  rmSync(home, { recursive: true, force: true })
})

interface Rpc {
  id?: string | number | null
  method?: string
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: { error?: string; retryable?: boolean } }
}

interface Client {
  bridge: Bridge
  /** Everything ever written to stdout, byte for byte. */
  stdout: () => string
  /** Server-initiated JSON-RPC, which over stdio really does reach the client. */
  notifications: Rpc[]
  request: (id: number, method: string, params?: Record<string, unknown>) => Promise<Rpc>
  notify: (method: string) => void
}

/** A stdio MCP client: writes one JSON-RPC message per line, reads the same back. */
const client = async (options: Partial<BridgeOptions> = {}): Promise<Client> => {
  const input = new PassThrough()
  const output = new PassThrough()
  const waiters = new Map<number, (message: Rpc) => void>()
  const notifications: Rpc[] = []
  let raw = ''
  let buffer = ''

  output.on('data', (chunk: Buffer) => {
    raw += String(chunk)
    buffer += String(chunk)
    for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n')) {
      const line = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 1)
      if (line === '') continue
      const message = JSON.parse(line) as Rpc
      if (message.id === undefined || message.id === null) {
        notifications.push(message)
        continue
      }
      waiters.get(Number(message.id))?.(message)
      waiters.delete(Number(message.id))
    }
  })

  const bridge = await startBridge({ input, output, ports: [0], wakeGraceMs: 100, ...options })
  bridges.push(bridge)

  return {
    bridge,
    stdout: () => raw,
    notifications,
    request: (id, method, params) => {
      const pending = new Promise<Rpc>((resolve) => waiters.set(id, resolve))
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
      return pending
    },
    notify: (method) => input.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
  }
}

type ToolCall = Extract<HostFrame, { type: 'tool.call' }>

interface Extension {
  socket: WebSocket
  frames: HostFrame[]
  calls: ToolCall[]
  /** The secret the bridge minted on a first pairing, read off the raw welcome frame. */
  secret: string | null
  push: (tools: AttachedTool[]) => Promise<void>
  answer: (id: string, result: unknown) => void
}

const tool = (name: string, sideEffect: AttachedTool['side_effect'] = 'read'): AttachedTool => ({
  name,
  description: `The ${name} tool`,
  input_schema: { type: 'object', properties: { tag: { type: 'string' } } },
  side_effect: sideEffect,
})

/** The extension side: dials in, presents a credential, pushes a surface, answers calls. */
const attach = async (bridge: Bridge, credential: Record<string, string>): Promise<Extension | null> => {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`)
  sockets.push(socket)
  const frames: HostFrame[] = []
  const calls: ToolCall[] = []
  let secret: string | null = null

  const welcomed = new Promise<boolean>((resolve) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as HostFrame & { secret?: string }
      frames.push(frame)
      if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
      if (frame.type === 'tool.call') calls.push(frame)
      if (frame.type !== 'welcome') return
      secret = frame.secret ?? null
      resolve(true)
    })
    socket.on('close', () => resolve(false))
    socket.on('error', () => resolve(false))
    socket.on('open', () =>
      socket.send(JSON.stringify({ type: 'hello', extension_version: '0.1.0', ...credential })),
    )
  })

  if (!(await welcomed)) return null
  return {
    socket,
    frames,
    calls,
    secret,
    push: async (tools) => {
      socket.send(JSON.stringify({ type: 'surface.push', tools }))
      // The push is one-way, so settle it before asserting on what the host now knows.
      await new Promise((resolve) => setTimeout(resolve, 30))
    },
    answer: (id, result) => socket.send(JSON.stringify({ type: 'tool.result', id, result })),
  }
}

/** Pairs a fresh bridge the way a human does: read the code off the bridge, type it in. */
const paired = async (options: Partial<BridgeOptions> = {}): Promise<[Client, Extension]> => {
  const mcp = await client(options)
  const extension = await attach(mcp.bridge, { code: mcp.bridge.code ?? '' })
  expect(extension).not.toBeNull()
  return [mcp, extension as Extension]
}

/** The same extension coming back after a drop. A refusal here would be a bug in the test. */
const reattach = async (bridge: Bridge, extension: Extension): Promise<Extension> => {
  const returned = await attach(bridge, { secret: extension.secret ?? '' })
  expect(returned).not.toBeNull()
  return returned as Extension
}

const toolsOf = (message: Rpc): { name: string; annotations: Record<string, boolean> }[] =>
  (message.result?.['tools'] ?? []) as { name: string; annotations: Record<string, boolean> }[]

const until = async (predicate: () => boolean, ms = 1000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

describe('the stdio end', () => {
  it('answers initialize and tools/list from the pushed surface with no client involvement', async () => {
    const [mcp, extension] = await paired()
    await extension.push([tool('shop_list_orders'), tool('shop_cancel_order', 'destructive')])

    const initialized = await mcp.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    const listed = await mcp.request(2, 'tools/list')

    expect(initialized.result?.['capabilities']).toEqual({ tools: { listChanged: true } })
    expect(toolsOf(listed).map((entry) => entry.name)).toEqual(['shop_list_orders', 'shop_cancel_order'])
    expect(toolsOf(listed)[1]?.annotations['destructiveHint']).toBe(true)
    // The extension answered nothing: sessions belong to the host, which is what lets a bridge
    // started before Chrome still describe itself.
    expect(extension.calls).toEqual([])
  })

  it('tells the client the surface changed, because stdio can carry a notification', async () => {
    const [mcp, extension] = await paired()

    await extension.push([tool('shop_list_orders')])

    await until(() => mcp.notifications.length > 0)
    expect(mcp.notifications[0]?.method).toBe('notifications/tools/list_changed')
  })

  it('round-trips a tools/call and stamps it local, which is what a destructive tool needs', async () => {
    const [mcp, extension] = await paired()
    await extension.push([tool('shop_cancel_order', 'destructive')])

    const pending = mcp.request(3, 'tools/call', {
      name: 'shop_cancel_order',
      arguments: { tag: 'A-1', confirm: true },
    })
    await until(() => extension.calls.length === 1)
    const call = extension.calls[0] as ToolCall
    extension.answer(call.id, { content: [{ type: 'text', text: 'cancelled' }] })

    expect(call.trust).toBe('local')
    expect(call.args).toEqual({ tag: 'A-1', confirm: true })
    expect((await pending).result).toEqual({ content: [{ type: 'text', text: 'cancelled' }] })
  })

  it('answers a malformed line rather than dropping it, and never throws on a notification', async () => {
    const mcp = await client()

    mcp.notify('notifications/initialized')
    const answered = await mcp.request(4, 'ping')

    expect(answered.result).toEqual({})
  })
})

describe('pairing', () => {
  it('refuses a socket that never saw the code, and stays refusing it', async () => {
    const mcp = await client()

    const impostor = await attach(mcp.bridge, { code: 'AAAA-AAAA' })

    expect(impostor).toBeNull()
    // Nothing attached, so a call is refused as offline rather than running at local trust.
    const answered = await mcp.request(1, 'tools/call', { name: 'shop_list_orders', arguments: {} })
    expect(answered.error?.data?.error).toBe('extension_disconnected')
  })

  it('refuses a socket presenting no credential at all', async () => {
    const mcp = await client()

    expect(await attach(mcp.bridge, {})).toBeNull()
  })

  it('attaches the one that presents the code, and mints a credential for next time', async () => {
    const [, extension] = await paired()

    expect(extension.secret).toMatch(/^[\w-]{43}$/)
    expect(statSync(credentialFile()).mode & 0o777).toBe(0o600)
    // The secret itself is never written down on the bridge's side.
    expect(JSON.stringify(statSync(credentialFile()))).not.toContain(extension.secret)
  })

  it('survives a restart: the credential attaches and no new code is printed', async () => {
    const [first, extension] = await paired()
    const secret = extension.secret as string
    await first.bridge.close()
    bridges.length = 0

    const second = await client()

    expect(second.bridge.code).toBeNull()
    expect(await attach(second.bridge, { secret })).not.toBeNull()
    // And the code from the first run is dead — a credential, not a code, is what attaches now.
    expect(await attach(second.bridge, { code: first.bridge.code ?? '' })).toBeNull()
  })

  it('refuses a stale secret once the pairing file is gone', async () => {
    const [first, extension] = await paired()
    const secret = extension.secret as string
    await first.bridge.close()
    bridges.length = 0
    rmSync(credentialFile())

    const second = await client()

    expect(second.bridge.code).not.toBeNull()
    expect(await attach(second.bridge, { secret })).toBeNull()
  })

  it('stops answering after too many failed attempts, so a short code cannot be guessed', async () => {
    const mcp = await client()

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await attach(mcp.bridge, { code: 'ZZZZ-ZZZZ' })).toBeNull()
    }

    // The real code no longer works either: the process is done pairing until it is restarted,
    // and only the user's own MCP client restarts it.
    expect(await attach(mcp.bridge, { code: mcp.bridge.code ?? '' })).toBeNull()
  })
})

describe('the attachment lifecycle', () => {
  it('fails an in-flight call when the extension drops, and never silently retries it', async () => {
    const [mcp, extension] = await paired()
    await extension.push([tool('shop_cancel_order', 'destructive')])

    const pending = mcp.request(5, 'tools/call', { name: 'shop_cancel_order', arguments: {} })
    await until(() => extension.calls.length === 1)
    extension.socket.terminate()

    const answered = await pending
    expect(answered.error?.data).toEqual({ error: 'extension_disconnected', retryable: true })

    // A write may already have landed on the far side, so the human decides — not the bridge.
    const returned = await reattach(mcp.bridge, extension)
    await returned.push([tool('shop_cancel_order', 'destructive')])
    expect(returned.calls).toEqual([])
  })

  it('holds a call for a waking worker instead of reporting an asleep browser as gone', async () => {
    const [mcp, extension] = await paired({ wakeGraceMs: 2000 })
    await extension.push([tool('shop_list_orders')])
    extension.socket.terminate()
    // The close travels the loopback socket, so let the bridge see it before the call arrives —
    // otherwise this asserts on the send-into-a-dying-socket path instead of the grace.
    await new Promise((resolve) => setTimeout(resolve, 60))

    const pending = mcp.request(6, 'tools/call', { name: 'shop_list_orders', arguments: {} })
    const returned = await reattach(mcp.bridge, extension)
    await until(() => returned.calls.length === 1)
    returned.answer((returned.calls[0] as ToolCall).id, { content: [] })

    expect((await pending).result).toEqual({ content: [] })
  })

  it('lets a reconnecting extension replace the socket it left behind', async () => {
    const [mcp, first] = await paired()

    const second = await reattach(mcp.bridge, first)
    await second.push([tool('shop_list_orders')])

    const listed = await mcp.request(7, 'tools/list')
    expect(toolsOf(listed).map((entry) => entry.name)).toEqual(['shop_list_orders'])
  })
})

describe('stdout', () => {
  /**
   * The one test that stops a whole class of bug: a stdio MCP server shares stdout with the
   * protocol, so any diagnostic written there corrupts the session in a way that reads as the
   * server being broken. Every path below produces stderr output — a pairing code, a refusal, a
   * detach — and none of it may appear here.
   */
  it('carries JSON-RPC and nothing else, whatever else the bridge has to say', async () => {
    const mcp = await client()
    await attach(mcp.bridge, { code: 'AAAA-AAAA' })
    const [, extension] = [null, await attach(mcp.bridge, { code: mcp.bridge.code ?? '' })]
    await extension?.push([tool('shop_list_orders')])
    await mcp.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    await mcp.request(2, 'tools/list')
    extension?.socket.terminate()
    await until(() => mcp.stdout().includes('shop_list_orders'))

    for (const line of mcp.stdout().split('\n')) {
      if (line === '') continue
      const parsed = JSON.parse(line) as Rpc & { jsonrpc?: string }
      expect(parsed.jsonrpc).toBe('2.0')
    }
    expect(mcp.stdout()).not.toContain(mcp.bridge.code ?? 'never')
  })

  /**
   * The stream test above only sees what goes through the injected output. A `console.log` or a
   * `process.stdout.write` bypasses it entirely and corrupts the session of every real client, so
   * the ban is checked where it can actually be broken: the source.
   */
  it('is never written to by any other route in this package', () => {
    const read = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')

    for (const file of ['bridge.ts', 'pairing.ts', 'index.ts']) {
      expect(read(file), file).not.toMatch(/console\.|process\.stdout/)
    }
    // bin.ts is the one place the real stdout exists, and all it may do is hand it over.
    const bin = read('bin.ts')
    expect(bin).not.toMatch(/console\.|process\.stdout\.write/)
    expect(bin.match(/process\.stdout/g)).toHaveLength(1)
  })
})
