import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Douzed, REPO, TSX } from '../harness.js'

/**
 * COV_REC_002.3 — the property that makes review the tuning surface rather than a one-time gate:
 * an edit saved in review reaches a CONNECTED MCP client within seconds, with no restart. This
 * spec drives a real `douze --mcp` child over stdio and watches for the notification.
 */
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
`

/** A minimal JSON-RPC-over-stdio client, so the assertion is on the wire, not on an abstraction. */
class McpClient {
  private readonly child: ChildProcess
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, (value: unknown) => void>()
  readonly notifications: string[] = []

  constructor(home: string) {
    this.child = spawn(TSX, [join(REPO, 'packages/cli/src/bin.ts'), '--mcp'], {
      env: { ...process.env, DOUZE_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout!.on('data', (chunk) => {
      this.buffer += String(chunk)
      for (const line of this.buffer.split('\n').slice(0, -1)) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown }
        if (message.method) this.notifications.push(message.method)
        else if (message.id !== undefined) this.pending.get(message.id)?.(message.result)
      }
      this.buffer = this.buffer.slice(this.buffer.lastIndexOf('\n') + 1)
    })
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      clientInfo: { name: 'e2e', version: '1.0.0' },
    })
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  }

  kill(): void {
    this.child.kill()
  }
}

test.describe('COV_REC_002: Promotion gating and live propagation', () => {
  let douzed: Douzed
  let client: McpClient

  test.beforeEach(async () => {
    douzed = new Douzed()
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), RECIPE)
    writeFileSync(join(douzed.fixturesDir, 'list_orders.json'), '{"data":{"orders":[]}}')
    await douzed.start()
    client = new McpClient(douzed.home)
    await client.initialize()
  })

  test.afterEach(() => {
    client.kill()
    douzed.stop()
  })

  test('@COV_REC_002.3 should reach a running client without a restart', async () => {
    const before = await client.request('tools/list')
    const listed = before.tools.find((t: { name: string }) => t.name === 'orders_list_orders')
    expect(listed.description).toBe('Lists every order.')

    const notificationsBefore = client.notifications.length
    const started = Date.now()

    // The edit review would make: change the description and save the recipe.
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), RECIPE.replace('Lists every order.', 'Lists orders that are still open, newest first.'))

    // AC-REC-002.3 / AC-RUN-002.2 — within 30 seconds, no restart, and the client is told.
    await expect
      .poll(
        async () => {
          const now = await client.request('tools/list')
          return now.tools.find((t: { name: string }) => t.name === 'orders_list_orders')?.description
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toBe('Lists orders that are still open, newest first.')

    expect(Date.now() - started).toBeLessThan(30_000)
    expect(client.notifications.length).toBeGreaterThan(notificationsBefore)
    expect(client.notifications).toContain('notifications/tools/list_changed')
  })

  test('@COV_REC_002.5 should not expose an unapproved candidate', async () => {
    writeFileSync(
      join(douzed.recipesDir, 'orders.yaml'),
      `${RECIPE}
  - name: secret_tool
    description: Should never be exposed.
    side_effect: read
    confidence: 0.5
    observations: 1
    approved: false
    request:
      method: GET
      path: /api/secret
`,
    )

    // Give the registry time to reload; the unapproved tool must never appear. `status` and
    // `sessions` are the CLI's own daemon commands, which incur also exposes over MCP.
    await new Promise((r) => setTimeout(r, 3_000))
    const names = (await client.request('tools/list')).tools.map((t: { name: string }) => t.name)

    expect(names).not.toContain('orders_secret_tool')
    expect(names).toContain('orders_list_orders')
    expect(names.filter((n: string) => n.startsWith('orders_'))).toEqual(['orders_list_orders'])
  })

  test('@COV_REC_002.4 should refuse a destructive tool approved without a confirm parameter', async () => {
    // The recipe schema itself enforces this, so the recipe fails to load rather than exposing
    // a destructive tool that could fire without confirmation.
    writeFileSync(
      join(douzed.recipesDir, 'danger.yaml'),
      `version: 1
name: danger
enabled: true
target:
  base_url: http://127.0.0.1:4180
tools:
  - name: delete_everything
    description: Deletes everything.
    side_effect: destructive
    confidence: 0.9
    observations: 1
    approved: true
    fixtures: [list_orders.json]
    request:
      method: DELETE
      path: /api/all
`,
    )

    await expect
      .poll(async () => (await (await douzed.api('/registry')).json()).errors.length, { timeout: 10_000 })
      .toBe(1)

    const state = await (await douzed.api('/registry')).json()
    expect(state.errors[0].error).toContain('confirm')
    // And the dangerous tool never reached the client.
    const tools = await client.request('tools/list')
    expect(tools.tools.map((t: { name: string }) => t.name)).not.toContain('danger_delete_everything')
  })
})
