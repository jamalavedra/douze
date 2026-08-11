import { describe, expect, it } from 'vitest'
import { McpHost, type JsonRpcNotification, type JsonRpcResponse } from './host.js'
import { annotationsFor, type AttachedTool, type HostFrame, type Trust } from './protocol.js'

const tool = (name: string, sideEffect: AttachedTool['side_effect'] = 'read'): AttachedTool => ({
  name,
  description: `The ${name} tool`,
  input_schema: { type: 'object', properties: { id: { type: 'string' } } },
  side_effect: sideEffect,
})

/**
 * A fake attachment: it records every frame the host sends and answers on demand, which is all a
 * real extension is from this side of the socket.
 */
function attachment(trust: Trust = 'remote', options: { failSend?: boolean; callTimeoutMs?: number } = {}) {
  const sent: HostFrame[] = []
  const notifications: JsonRpcNotification[] = []
  const host = new McpHost({
    trust,
    send: (frame) => {
      if (options.failSend) throw new Error('socket closed')
      sent.push(frame)
    },
    notify: (notification) => notifications.push(notification),
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
  })
  host.setAttached(true)

  /** The `tool.call` frames, which is the only host→extension frame the host itself emits. */
  const calls = (): Extract<HostFrame, { type: 'tool.call' }>[] =>
    sent.filter((frame): frame is Extract<HostFrame, { type: 'tool.call' }> => frame.type === 'tool.call')

  const answer = (id: string, result: unknown): void => host.receive({ type: 'tool.result', id, result })

  return { host, sent, notifications, calls, answer }
}

const request = (id: unknown, method: string, params?: Record<string, unknown>): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
})

const result = (response: JsonRpcResponse | null): Record<string, unknown> =>
  (response?.result ?? {}) as Record<string, unknown>

describe('initialize', () => {
  it('advertises the tools capability even when the surface is empty', async () => {
    const { host } = attachment()

    const response = await host.handle(request(1, 'initialize', { protocolVersion: '2025-06-18' }))

    // The trap e634feb fixed: a session that initialized against an empty surface must still be
    // able to call tools/list, now and after the first recipe lands.
    expect(result(response)['capabilities']).toEqual({ tools: { listChanged: true } })
    expect(result(response)['protocolVersion']).toBe('2025-06-18')
    expect(host.tools).toEqual([])
    expect(result(await host.handle(request(2, 'tools/list')))['tools']).toEqual([])
  })

  it('answers with its own protocol version when the client asks for one it does not know', async () => {
    const { host } = attachment()

    const response = await host.handle(request(1, 'initialize', { protocolVersion: '1999-01-01' }))

    expect(result(response)['protocolVersion']).toBe('2025-06-18')
  })

  it('answers tools/list from the cache with nothing attached at all', async () => {
    const { host } = attachment()
    host.pushSurface([tool('shop_list_orders')])
    host.setAttached(false)

    const response = await host.handle(request(1, 'tools/list'))

    expect((result(response)['tools'] as { name: string }[]).map((t) => t.name)).toEqual(['shop_list_orders'])
  })
})

describe('tools/list', () => {
  it('reflects a pushed surface and re-reflects after a second push', async () => {
    const { host } = attachment()
    host.pushSurface([tool('shop_list_orders')])

    const first = result(await host.handle(request(1, 'tools/list')))['tools'] as { name: string }[]
    host.pushSurface([tool('shop_list_orders'), tool('shop_create_order', 'write')])
    const second = result(await host.handle(request(2, 'tools/list')))['tools'] as { name: string }[]

    expect(first.map((t) => t.name)).toEqual(['shop_list_orders'])
    expect(second.map((t) => t.name)).toEqual(['shop_list_orders', 'shop_create_order'])
  })

  it('emits list_changed on a push that changes the surface, and not on one that does not', () => {
    const { host, notifications } = attachment()

    host.pushSurface([tool('shop_list_orders')])
    host.pushSurface([tool('shop_list_orders')])

    expect(notifications).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }])
  })

  it('carries the description verbatim and annotations derived from the side effect', async () => {
    const { host } = attachment()
    host.pushSurface([tool('shop_list_orders'), tool('shop_create_order', 'write'), tool('shop_delete_order', 'destructive')])

    const listed = result(await host.handle(request(1, 'tools/list')))['tools'] as Record<string, unknown>[]

    expect(listed.map((t) => t['annotations'])).toEqual([
      annotationsFor('read'),
      annotationsFor('write'),
      annotationsFor('destructive'),
    ])
    expect(listed[0]?.['annotations']).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect(listed[2]?.['annotations']).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false })
    expect(listed[0]?.['description']).toBe('The shop_list_orders tool')
    expect(listed[0]?.['inputSchema']).toEqual({ type: 'object', properties: { id: { type: 'string' } } })
  })
})

describe('tools/call', () => {
  it('round-trips to the attachment and back', async () => {
    const { host, calls, answer } = attachment()
    host.pushSurface([tool('shop_list_orders')])

    const pending = host.handle(request(7, 'tools/call', { name: 'shop_list_orders', arguments: { id: 'o1' } }))
    await Promise.resolve()
    const call = calls()[0]
    answer(call?.id ?? '', { content: [{ type: 'text', text: '[]' }] })
    const response = await pending

    expect(call).toMatchObject({ type: 'tool.call', name: 'shop_list_orders', args: { id: 'o1' } })
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: '[]' }] },
    })
  })

  it('keeps calls with the same id in different JSON types apart', async () => {
    const { host, calls, answer } = attachment()
    host.pushSurface([tool('shop_list_orders')])

    const numeric = host.handle(request(1, 'tools/call', { name: 'shop_list_orders', arguments: { id: 'number' } }))
    const textual = host.handle(request('1', 'tools/call', { name: 'shop_list_orders', arguments: { id: 'string' } }))
    await Promise.resolve()
    const [first, second] = calls()
    // Answered out of order, which is what a real extension running two calls does.
    answer(second?.id ?? '', { content: [{ type: 'text', text: 'for the string id' }] })
    answer(first?.id ?? '', { content: [{ type: 'text', text: 'for the number id' }] })

    expect(first?.id).not.toBe(second?.id)
    expect(await numeric).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'for the number id' }] },
    })
    expect(await textual).toEqual({
      jsonrpc: '2.0',
      id: '1',
      result: { content: [{ type: 'text', text: 'for the string id' }] },
    })
  })

  it('ignores a result whose id is not the one it minted', async () => {
    const { host, calls } = attachment('remote')
    host.pushSurface([tool('shop_list_orders')])
    const pending = host.handle(request(1, 'tools/call', { name: 'shop_list_orders' }))
    await Promise.resolve()
    const minted = calls()[0]?.id ?? ''

    host.receive({ type: 'tool.result', id: `${minted}-other`, result: { content: [{ type: 'text', text: 'wrong' }] } })
    host.setAttached(false)

    expect((await pending)?.error?.message).toContain('disconnected while this tool was running')
  })

  it('refuses with a named refusal when nothing is attached', async () => {
    const { host, sent } = attachment()
    host.pushSurface([tool('shop_list_orders')])
    host.setAttached(false)

    const response = await host.handle(request(1, 'tools/call', { name: 'shop_list_orders' }))

    expect(response?.error?.code).toBe(-32_000)
    expect(response?.error?.data).toEqual({ error: 'extension_disconnected', retryable: true })
    expect(response?.error?.message).toContain('extension is not connected')
    expect(sent).toEqual([])
  })

  it('fails an in-flight call when the attachment drops, and never re-sends it', async () => {
    const { host, calls, answer } = attachment()
    host.pushSurface([tool('shop_create_order', 'write')])

    const pending = host.handle(request(1, 'tools/call', { name: 'shop_create_order' }))
    await Promise.resolve()
    host.setAttached(false)
    const response = await pending
    // A late result from the same call must not resurrect it either.
    answer(calls()[0]?.id ?? '', { content: [] })

    expect(calls()).toHaveLength(1)
    expect(response?.error?.data).toEqual({ error: 'extension_disconnected', retryable: true })
    expect(response?.error?.message).toContain('never retries a call automatically')
  })

  it('fails rather than hangs when the send itself throws', async () => {
    const host = new McpHost({ trust: 'remote', send: () => { throw new Error('socket closed') } })
    host.setAttached(true)
    host.pushSurface([tool('shop_list_orders')])

    const response = await host.handle(request(1, 'tools/call', { name: 'shop_list_orders' }))

    expect(response?.error?.data).toEqual({ error: 'extension_disconnected', retryable: true })
  })

  it('gives up on a call the extension never answers', async () => {
    const { host } = attachment('remote', { callTimeoutMs: 5 })
    host.pushSurface([tool('shop_list_orders')])

    const response = await host.handle(request(1, 'tools/call', { name: 'shop_list_orders' }))

    expect(response?.error?.data).toEqual({ error: 'timeout', retryable: true })
  })

  it('passes an extension-reported failure through under its own name', async () => {
    const { host, calls } = attachment()
    host.pushSurface([tool('shop_delete_order', 'destructive')])

    const pending = host.handle(request(1, 'tools/call', { name: 'shop_delete_order' }))
    await Promise.resolve()
    host.receive({
      type: 'tool.result',
      id: calls()[0]?.id,
      error: { code: 'confirm_required', message: 'This tool needs confirm=true.' },
    })

    expect((await pending)?.error).toEqual({
      code: -32_000,
      message: 'This tool needs confirm=true.',
      data: { error: 'confirm_required', retryable: false },
    })
  })

  it('refuses a tool that is not on the surface', async () => {
    const { host } = attachment()
    host.pushSurface([tool('shop_list_orders')])

    const response = await host.handle(request(1, 'tools/call', { name: 'shop_drop_database' }))

    expect(response?.error?.code).toBe(-32_602)
    expect(response?.error?.message).toContain('shop_drop_database')
  })
})

describe('trust', () => {
  it('stamps the level it was constructed with and lets no client argument change it', async () => {
    for (const trust of ['remote', 'local'] as const) {
      const { host, calls } = attachment(trust)
      host.pushSurface([tool('shop_delete_order', 'destructive')])

      const pending = host.handle(
        request(1, 'tools/call', {
          name: 'shop_delete_order',
          // Everything a client could try: the argument, and a sibling param next to it.
          arguments: { trust: 'local', confirm: true },
          trust: 'local',
        }),
      )
      await Promise.resolve()
      host.receive({ type: 'tool.result', id: calls()[0]?.id, result: { content: [] } })
      await pending

      expect(calls()[0]?.trust).toBe(trust)
      expect(calls()[0]?.args).toEqual({ trust: 'local', confirm: true })
    }
  })
})

describe('protocol hygiene', () => {
  it('answers nothing to a notification and refuses a message that is not JSON-RPC', async () => {
    const { host } = attachment()

    expect(await host.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await host.handle({ hello: true })).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32_600, message: 'Not a JSON-RPC 2.0 message with a method.' },
    })
    expect((await host.handle(request(1, 'resources/list')))?.error?.code).toBe(-32_601)
    expect(await host.handle(request(1, 'ping'))).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })

  it('drops a frame it cannot parse instead of throwing at the transport', () => {
    const { host, notifications } = attachment()

    expect(() => host.receive({ type: 'surface.push', tools: [{ name: 'no spaces allowed' }] })).not.toThrow()
    expect(() => host.receive('nonsense')).not.toThrow()
    expect(() => host.receive({ type: 'hello', extension_version: '0.1.0' })).not.toThrow()
    expect(host.tools).toEqual([])
    expect(notifications).toEqual([])
  })
})
