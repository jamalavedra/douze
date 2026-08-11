import { test, expect } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpClient, REPO, waitFor } from '../harness.js'

/**
 * COV_CON_005 — the connector starting from nothing. This is the path every real install takes
 * and the one that used to fail: the MCP server awaited a daemon before connecting its transport,
 * and got the daemon by re-exec'ing `process.execPath`. Inside Claude Desktop that is an Electron
 * binary and not a Node to spawn, so the daemon never came up, `initialize` was never answered,
 * and the connector died 45 seconds later — with the extension reporting that it could not reach
 * anything, which is what a user saw.
 *
 * Everything here therefore starts with NO daemon running. `DOUZE_ENTRY` is pointed at a path
 * that does not exist so that any return to re-exec fails this suite rather than passing on a
 * developer's machine, where `process.execPath` happens to be a real Node.
 */
const ORDERS_RECIPE = `
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
`

const ENTRY = join(REPO, 'packages/cli/dist/index.js')

interface Runtime {
  pid: number
  port: number
}

const children: ChildProcess[] = []
const homes: string[] = []

/** A home with the recipe already approved, exactly as a review would have left it. */
function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'douze-cold-'))
  homes.push(home)
  for (const dir of ['recipes', 'fixtures']) mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, 'recipes', 'orders.yaml'), ORDERS_RECIPE)
  writeFileSync(join(home, 'fixtures', 'list_orders.json'), '{"data":{"orders":[]}}')
  return home
}

/**
 * The MCP server as a client launches it: the built single file, `--mcp`, and nothing else
 * configured. DOUZE_PORT=0 keeps this suite off the 8787-8791 range a real install walks.
 */
function launch(home: string): McpClient {
  const child = spawn('node', [ENTRY, '--mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DOUZE_HOME: home, DOUZE_PORT: '0', DOUZE_ENTRY: '/nonexistent/douze-entry.js' },
  })
  children.push(child)
  return new McpClient(child)
}

const runtimeOf = (home: string): Runtime | null => {
  try {
    return JSON.parse(readFileSync(join(home, 'douzed.json'), 'utf8')) as Runtime
  } catch {
    return null
  }
}

test.describe('COV_CON_005: a connector that starts from nothing', () => {
  test.beforeAll(() => {
    test.setTimeout(300_000)
    execFileSync('pnpm', ['--filter', '@douze/cli', 'build'], { cwd: REPO, stdio: 'inherit' })
  })

  test.afterAll(async () => {
    for (const child of children) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill()
      await exited
    }
    for (const home of homes) rmSync(home, { recursive: true, force: true })
  })

  test('@COV_CON_005.1 should answer initialize and serve tools with no daemon running', async () => {
    test.setTimeout(120_000)
    const home = scratchHome()
    expect(runtimeOf(home)).toBeNull()

    const client = launch(home)
    // The handshake is the assertion: it used to be answered never. A generous ceiling still
    // fails the old behaviour by 35 seconds, and does not flake on a loaded CI box.
    await expect(client.initialize()).resolves.toBeUndefined()

    // The daemon came up inside this process — no detached child, no node to spawn.
    await waitFor(async () => runtimeOf(home) !== null, 'douzed.json')
    expect(runtimeOf(home)!.pid).toBe(client.child.pid)

    await expect.poll(() => client.tools(), { timeout: 30_000, intervals: [250] }).toContain('orders_list_orders')
  })

  test('@COV_CON_005.2 should adopt the running daemon rather than start a second one', async () => {
    test.setTimeout(120_000)
    const home = scratchHome()

    const first = launch(home)
    await first.initialize()
    await waitFor(async () => runtimeOf(home) !== null, 'douzed.json')
    await expect.poll(() => first.tools(), { timeout: 30_000, intervals: [250] }).toContain('orders_list_orders')
    const hosting = runtimeOf(home)!

    // A second client — Cursor open next to Claude Desktop — sees the same tools, and the daemon
    // behind them is still the first process. Two daemons would mean two registries and a review
    // page the extension cannot find.
    const second = launch(home)
    await second.initialize()
    await expect.poll(() => second.tools(), { timeout: 30_000, intervals: [250] }).toContain('orders_list_orders')

    expect(runtimeOf(home)).toEqual(hosting)
    expect(hosting.pid).toBe(first.child.pid)
    expect(hosting.pid).not.toBe(second.child.pid)
  })

  test('@COV_CON_005.3 should stay connected when the daemon cannot start at all', async () => {
    test.setTimeout(120_000)
    // A home that can never be created: the daemon fails on its first line, every time.
    const blocked = join(mkdtempSync(join(tmpdir(), 'douze-cold-')), 'not-a-directory')
    homes.push(blocked)
    writeFileSync(blocked, 'this is a file')

    const client = launch(blocked)
    // The point of the fix: a broken daemon is a connector with no recipe tools, not a dead one.
    // `status` survives because it is registered from the command tree, so the user can still ask
    // Douze what is wrong from inside the chat (REQ-CON-004).
    await expect(client.initialize()).resolves.toBeUndefined()
    const tools = await client.tools()
    expect(tools).toContain('status')
    expect(tools.filter((name) => name.startsWith('orders_'))).toEqual([])
    expect(client.child.killed).toBe(false)
    expect(client.child.exitCode).toBeNull()
  })
})
