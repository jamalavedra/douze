import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startRelay, type Relay } from '../../packages/relay/src/server.js'
import { Douzed, FixtureApp, waitFor } from '../harness.js'

/**
 * V-014.5 — the remote path end to end, standing in for a hosted connector: plain
 * streamable-HTTP MCP against a real relay, a real douzed dialling that relay from behind it, and
 * the fixture app as the only witness of what actually reached a target.
 *
 * No browser. The one piece a hosted client cannot supply is the signed-in session, so the
 * extension is scripted below — it answers the daemon's relay.request by issuing the request
 * itself with the fixture's session cookie, which is exactly what the real extension does from an
 * Executor Tab. Everything above that (relay, bridge, per-session MCP instance, remote scoping,
 * result gate) is the shipping code.
 */
const RECIPE = `
version: 1
name: orders
enabled: true
target:
  base_url: http://127.0.0.1:4180
auth:
  mode: browser_relay
  credential_source:
    - kind: cookie
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
  - name: create_order
    description: Creates an order.
    side_effect: write
    confidence: 0.9
    observations: 3
    approved: true
    fixtures: [create_order.json]
    request:
      method: POST
      path: /api/orders
      input_schema:
        type: object
        properties:
          item: { type: string }
        required: [item]
  - name: delete_order
    description: Deletes an order permanently.
    side_effect: destructive
    confidence: 0.8
    observations: 2
    approved: true
    fixtures: [delete_order.json]
    request:
      method: DELETE
      path: /api/orders/{orderId}
      input_schema:
        type: object
        properties:
          orderId: { type: integer }
          confirm: { type: boolean }
        required: [orderId, confirm]
`

const SESSION_COOKIE = 'fixture_session=s3ssion-fixture-value'

/**
 * The browser half, scripted: it holds the session and issues the request, and the daemon never
 * sees a credential. Node 22 has a global WebSocket, so this needs nothing installed.
 */
function scriptExtension(port: number, token: string): { ready: Promise<void>; close: () => void } {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener('error', () => reject(new Error('scripted extension could not connect')))
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', token, extension_version: '0.1.0' }))
      resolve()
    })
  })

  socket.addEventListener('message', (event: MessageEvent) => {
    const frame = JSON.parse(String(event.data)) as {
      type: string
      request?: { id: string; url: string; method: string; headers?: Record<string, string>; body?: unknown }
    }
    if (frame.type === 'ping') return socket.send(JSON.stringify({ type: 'pong' }))
    const request = frame.request
    if (frame.type !== 'relay.request' || !request) return

    const started = Date.now()
    void fetch(request.url, {
      method: request.method,
      headers: { ...request.headers, cookie: SESSION_COOKIE },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    })
      .then(async (response) => ({
        id: request.id,
        ok: response.ok,
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
        body: await response.json().catch(() => undefined),
        duration_ms: Date.now() - started,
        redirected_to_login: false,
      }))
      .catch((error: Error) => ({
        id: request.id,
        ok: false,
        headers: {},
        duration_ms: Date.now() - started,
        error: error.message,
        redirected_to_login: false,
      }))
      .then((response) => socket.send(JSON.stringify({ type: 'relay.response', id: request.id, response })))
  })

  return { ready, close: () => socket.close() }
}

test.describe('V-014.5: A hosted connector over the relay', () => {
  let app: FixtureApp
  let relay: Relay
  let douzed: Douzed
  let extension: { ready: Promise<void>; close: () => void }
  let mcpUrl: string
  let sessionId: string

  /** One POST to the relay's MCP endpoint, exactly as a hosted client would make it. */
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as unknown) : undefined }
  }

  const rpc = async (id: number, method: string, params: Record<string, unknown> = {}) =>
    post({ jsonrpc: '2.0', id, method, params }, { 'Mcp-Session-Id': sessionId })

  test.beforeAll(async () => {
    app = new FixtureApp()
    await app.start()
    await app.reset()

    relay = await startRelay({ port: 0 })
    const registered = (await (
      await fetch(`http://127.0.0.1:${relay.port}/register`, {
        method: 'POST',
        body: JSON.stringify({ daemon_version: '0.1.0' }),
      })
    ).json()) as { token: string; mcp_path: string }
    mcpUrl = `http://127.0.0.1:${relay.port}${registered.mcp_path}`

    douzed = new Douzed({ remote: true })
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), RECIPE)
    for (const name of ['list_orders', 'create_order', 'delete_order']) {
      writeFileSync(join(douzed.fixturesDir, `${name}.json`), '{"data":{"orders":[]}}')
    }
    // Written before the daemon boots: the bridge reads this once, at startup.
    writeFileSync(
      join(douzed.home, 'relay.json'),
      JSON.stringify({
        url: `http://127.0.0.1:${relay.port}`,
        token: registered.token,
        mcp_path: registered.mcp_path,
        allow_writes: false,
      }),
    )
    await douzed.start()

    extension = scriptExtension(douzed.port, douzed.token)
    await extension.ready
    await waitFor(async () => (await (await douzed.api('/health')).json()).extension_connected, 'extension socket')
    // The daemon dials the relay on startup; until that socket lands the relay answers 503.
    await waitFor(async () => (await post({ jsonrpc: '2.0', id: 0, method: 'ping' })).status !== 503, 'daemon at relay')
    await app.reset()
  })

  test.afterAll(async () => {
    extension?.close()
    await douzed?.stop()
    await relay?.close()
    await app?.stop()
  })

  test('@V-014.5.1 should initialize a session over streamable HTTP', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hosted', version: '1.0' } },
    })

    expect(res.status).toBe(200)
    sessionId = res.headers.get('Mcp-Session-Id') ?? ''
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.body).toMatchObject({ id: 1, result: { serverInfo: { name: 'douze' } } })

    const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'Mcp-Session-Id': sessionId })
    expect(notified.status).toBe(202)
  })

  test('@V-014.5.2 should offer read tools only, with no write or destructive tool listed', async () => {
    // The surface arrives on the daemon's registry poll, so the first list can precede it.
    let names: string[] = []
    await expect
      .poll(
        async () => {
          const body = (await rpc(2, 'tools/list')).body as { result?: { tools?: { name: string }[] } }
          names = (body.result?.tools ?? []).map((t) => t.name)
          return names
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toContain('orders_list_orders')

    // T-014.3 — writes are off by default and destructive tools are never remotely callable.
    expect(names).not.toContain('orders_create_order')
    expect(names).not.toContain('orders_delete_order')
  })

  test('@V-014.5.3 should round-trip a read call through the daemon to the target', async () => {
    await app.reset()
    const res = await rpc(4, 'tools/call', { name: 'orders_list_orders', arguments: {} })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 4, result: { content: expect.any(Array) } })
    const text = (res.body as { result: { content: { text: string }[] } }).result.content[0]!.text
    expect(text).toContain('widget')

    // The fixture is the only witness that cannot lie: the request really was issued, carrying
    // the session, and it came from the browser side rather than from the daemon's own store.
    const log = await app.log()
    const relayed = log.find((r) => r.path === '/api/orders' && r.method === 'GET')
    expect(relayed).toBeTruthy()
    expect(relayed!.headers['cookie']).toContain('fixture_session=s3ssion-fixture-value')
  })

  test('@V-014.5.4 should refuse a destructive tool without issuing any request', async () => {
    await app.reset()
    const res = await rpc(5, 'tools/call', {
      name: 'orders_delete_order',
      arguments: { orderId: 1042, confirm: true },
    })

    // Refused, whatever the shape: the tool is not on the remote surface at all.
    const body = res.body as { result?: { isError?: boolean; content?: { text: string }[] }; error?: unknown }
    expect(body.error ?? body.result?.isError).toBeTruthy()
    expect(JSON.stringify(body)).toMatch(/no longer exists|not found|unknown/i)

    // AC-014 — and the target saw nothing, which is the assertion that matters.
    expect(await app.log()).toHaveLength(0)
  })
})
