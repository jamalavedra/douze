import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FixtureApp, Douzed, McpClient, REPO, launchHelium, waitFor } from '../harness.js'

/**
 * COV_CON_001 — the Claude Desktop connector, and the property that makes it a one-time act.
 *
 * WHAT IS AND IS NOT AUTOMATED: double-clicking a `.mcpb` into a real Claude Desktop cannot be
 * driven from here. What AC-CON-001.1 actually claims is that the artifact is installable and
 * that the server inside it, started the way the manifest says to start it, serves the enabled
 * recipes' tools. So the bundle is unzipped for real, its declared `entry_point` is run as an
 * MCP stdio server with NOTHING configured, and `tools/list` is read off the wire.
 *
 * "Nothing configured" is the assertion that matters here. The manifest declares no settings
 * form, and the server is spawned with no relay URL and no token in its environment: it has to
 * find the running daemon on its own, exactly as it does after a double-click.
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

/** AC-CON-001.4 — approved after the bundle was built and after the server was started. */
const REPORTS_RECIPE = `
version: 1
name: reports
enabled: true
target:
  base_url: http://127.0.0.1:4180
auth:
  mode: browser_relay
  credential_source:
    - kind: cookie
tools:
  - name: get_report
    description: Reports how many orders are open.
    side_effect: read
    confidence: 0.9
    observations: 3
    approved: true
    fixtures: [get_report.json]
    request:
      method: GET
      path: /api/report
    response:
      primary_payload_path: $.data.summary
`

interface Manifest {
  manifest_version: string
  server: {
    type: string
    entry_point: string
    mcp_config: { command: string; args: string[]; env?: Record<string, string> }
  }
  user_config?: unknown
}

test.describe('COV_CON_001: Claude Desktop connector', () => {
  let app: FixtureApp
  let douzed: Douzed
  let browser: Awaited<ReturnType<typeof launchHelium>>
  let client: McpClient
  let bundlePath: string
  let installDir: string
  let manifest: Manifest
  let listing: string[]

  test.beforeAll(async () => {
    // A CLI build, a browser launch, an extension handshake, and an MCP server child.
    test.setTimeout(300_000)

    app = new FixtureApp()
    await app.start()
    await app.reset()

    douzed = new Douzed()
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), ORDERS_RECIPE)
    writeFileSync(join(douzed.fixturesDir, 'list_orders.json'), '{"data":{"orders":[]}}')
    writeFileSync(join(douzed.fixturesDir, 'get_report.json'), '{"data":{"summary":{"open":2}}}')
    await douzed.start()

    browser = await launchHelium()
    await browser.serviceWorker.evaluate(
      ([port, token]) => (globalThis as never as DouzeApi).__douze.connect(Number(port), String(token)),
      [String(douzed.port), douzed.token] as const,
    )
    const page: Page = await browser.context.newPage()
    await page.goto(app.origin)
    // Sign in, exactly as the user would have before recording.
    await page.evaluate(() => fetch('/login', { method: 'POST' }).then((r) => r.json()))
    await waitFor(async () => (await (await douzed.api('/health')).json()).extension_connected, 'extension socket')
    await app.reset()

    // The bundle carries the built MCP server, so it has to exist before `douze bundle` runs.
    execFileSync('pnpm', ['--filter', '@douze/cli', 'build'], { cwd: REPO, stdio: 'inherit' })

    const out = mkdtempSync(join(tmpdir(), 'douze-mcpb-'))
    // No `--out`: the default name is what a reader is told to double-click, so it is asserted.
    // The BUILT CLI, not the TypeScript entry: `bundle` resolves the server it packages relative
    // to its own module path, which only lines up for the shipped single file — and that file is
    // what a user runs `douze bundle` from anyway.
    execFileSync('node', [join(REPO, 'packages/cli/dist/index.js'), 'bundle'], {
      cwd: out,
      env: { ...process.env, DOUZE_HOME: douzed.home },
      stdio: 'inherit',
    })
    bundlePath = join(out, 'Douze.mcpb')

    // Unzipped with the system tool: "valid ZIP" means a stock unzip can read it, not that our
    // own writer can read its own output.
    listing = execFileSync('unzip', ['-Z1', bundlePath], { encoding: 'utf8' }).trim().split('\n')
    installDir = join(out, 'installed')
    execFileSync('unzip', ['-o', '-q', bundlePath, '-d', installDir])
    manifest = JSON.parse(readFileSync(join(installDir, 'manifest.json'), 'utf8')) as Manifest

    // Install as Claude Desktop would: run the declared entry point with no configuration at all.
    // `DOUZE_HOME` is the one variable set, and only to keep this suite off a real install — it
    // is the directory a shipped connector would default to. No relay URL, no token: the server
    // resolves the running daemon itself, which is the whole claim of a zero-configuration install.
    const child = spawn('node', [join(installDir, manifest.server.entry_point), '--mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DOUZE_HOME: douzed.home },
    })
    client = new McpClient(child)
    await client.initialize()
  })

  test.afterAll(async () => {
    client?.kill()
    await browser?.dispose()
    await douzed?.stop()
    await app?.stop()
  })

  test('@COV_CON_001.1 should emit an installable bundle whose server serves the enabled tools', async () => {
    test.setTimeout(120_000)

    // AC-CON-001.1 — a `.mcpb` holding a manifest and the MCP server entry point. The name is
    // the default, since it is the filename a reader is told to double-click.
    expect(bundlePath.endsWith('/Douze.mcpb')).toBe(true)
    expect(statSync(bundlePath).size).toBeGreaterThan(1024)
    expect(listing).toContain('manifest.json')
    expect(listing).toContain('server/index.js')
    expect(manifest.server.entry_point).toBe('server/index.js')

    // AC-CON-001.3 — the Node inside Claude Desktop runs it; nothing extra is installed.
    expect(manifest.server.type).toBe('node')
    expect(manifest.server.mcp_config.command).toBe('node')
    expect(manifest.server.mcp_config.args).toContain('--mcp')

    // Installing asks the user for nothing: no settings form, and no configuration smuggled in
    // through the environment either. Whatever makes the tools below work, it is not something
    // a person had to type.
    expect(manifest.user_config).toBeUndefined()
    expect(manifest.server.mcp_config.env).toBeUndefined()

    const bundled = readFileSync(bundlePath, 'utf8')
    // The token never leaves the machine in an artifact a user might pass to someone else.
    expect(bundled).not.toContain(douzed.token)
    // The bundle itself carries no tool definitions — that is what makes AC-CON-001.4 possible.
    expect(bundled).not.toContain('list_orders')

    // AC-CON-001.1 — and the installed server serves the enabled recipe's tools.
    const tools = (await client.request('tools/list')).tools as { name: string; description: string }[]
    expect(tools.map((t) => t.name)).toContain('orders_list_orders')
    expect(tools.find((t) => t.name === 'orders_list_orders')?.description).toBe('Lists every order.')
  })

  test('@COV_CON_001.2 should expose a newly approved recipe with no reinstall and no rebuild', async () => {
    test.setTimeout(120_000)

    // Nothing about the installation may change for this to count.
    const bundleBefore = statSync(bundlePath)
    const pidBefore = client.child.pid
    const before = (await client.request('tools/list')).tools.map((t: { name: string }) => t.name)
    expect(before).not.toContain('reports_get_report')

    // A recipe approved after installation, written where the review UI writes it.
    writeFileSync(join(douzed.recipesDir, 'reports.yaml'), REPORTS_RECIPE)

    await expect
      .poll(async () => (await client.request('tools/list')).tools.map((t: { name: string }) => t.name), {
        timeout: 30_000,
        intervals: [500],
      })
      .toContain('reports_get_report')

    // Callable, not merely listed: this goes out through the relay to the signed-in browser.
    const result = await client.request('tools/call', { name: 'reports_get_report', arguments: {} })
    expect(result.isError ?? false).toBe(false)
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      status: number
      data: unknown
    }
    expect(payload.status).toBe(200)
    // Trimmed to the new recipe's primary payload path, so the recipe really drove the call.
    expect(payload.data).toEqual({ open: 2 })

    const served = (await app.log()).filter((r) => r.path === '/api/report')
    expect(served).toHaveLength(1)

    // The same process, from the same bytes: no reinstall, no rebuild (AC-CON-001.4).
    expect(client.child.pid).toBe(pidBefore)
    expect(client.child.killed).toBe(false)
    expect(statSync(bundlePath).mtimeMs).toBe(bundleBefore.mtimeMs)
    expect(statSync(bundlePath).size).toBe(bundleBefore.size)
    // And the client was told rather than left to poll (AC-RUN-002.2).
    expect(client.notified).toContain('notifications/tools/list_changed')
  })
})

interface DouzeApi {
  __douze: { connect(port: number, token: string): Promise<void> }
}
