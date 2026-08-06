import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { FixtureApp, Douzed, REPO, TSX, launchHelium, waitFor } from '../harness.js'

/**
 * COV_CON_002 — one command registers Douze with Claude Code, and COV_CON_003 — a long call
 * reports progress instead of looking hung.
 *
 * NEVER THE REAL CONFIG: `douze mcp add` writes to `~/.claude.json` for user and local scope, via
 * `os.homedir()`. On POSIX that reads `$HOME`, so every invocation here runs with `HOME` pointed
 * at a scratch directory — and the redirect is PROVEN with a probe before anything is written,
 * because a redirect that silently failed would edit the user's real config. Project scope needs
 * no redirect: it writes `.mcp.json` under the working directory.
 */

/** Resolved: macOS hands out `/var/...` and a child process reports it back as `/private/var/...`. */
const scratch = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), `douze-${prefix}-`)))

/**
 * The real config, so the spec can prove it was left alone — by content, not by mtime. Claude
 * Code rewrites this file on its own schedule, so a timestamp proves nothing about who wrote it
 * and fails the spec whenever the suite runs on a machine Claude Code is running on. What a
 * failed HOME redirect would actually do is add `mcpServers.douze` here, so that is what is read.
 */
const REAL_CLAUDE_JSON = join(homedir(), '.claude.json')
const realConfigHasDouze = (): boolean => {
  try {
    const config = JSON.parse(readFileSync(REAL_CLAUDE_JSON, 'utf8')) as { mcpServers?: Record<string, unknown> }
    return config.mcpServers?.['douze'] !== undefined
  } catch {
    return false
  }
}

interface Run {
  code: number
  out: string
}

const runDouze = (args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<Run> =>
  new Promise((resolve) => {
    const child = spawn(TSX, [join(REPO, 'packages/cli/src/bin.ts'), ...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk))
    child.stderr.on('data', (chunk: Buffer) => (out += chunk))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })

/** `Registered "<name>" at <scope> scope in <path>` — the claim the file has to back up. */
function reported(output: string): { name: string; scope: string; path: string } {
  const match = /Registered "([^"]+)" at (\w+) scope in (.+)/.exec(output)
  if (!match) throw new Error(`no registration line in output:\n${output}`)
  return { name: match[1] as string, scope: match[2] as string, path: (match[3] as string).trim() }
}

test.describe('COV_CON_002: Claude Code registration', () => {
  test('@COV_CON_002.1 should write a stdio entry invoking `douze --mcp` and report the scope it wrote', async () => {
    test.setTimeout(120_000)

    const project = scratch('cc-project')
    const home = scratch('cc-home')

    // --- project scope: no HOME involved, the file is under the working directory ------------
    const projectRun = await runDouze(['mcp', 'add', '--agent', 'claude-code', '--scope', 'project'], { cwd: project })
    expect(projectRun.code).toBe(0)

    const projectReport = reported(projectRun.out)
    expect(projectReport).toMatchObject({ name: 'douze', scope: 'project', path: join(project, '.mcp.json') })

    // AC-CON-002.1 — a stdio entry invoking `douze --mcp`, in the file the output named.
    const projectConfig = JSON.parse(readFileSync(projectReport.path, 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(projectConfig.mcpServers['douze']).toEqual({ type: 'stdio', command: 'douze', args: ['--mcp'] })

    // --- user scope: the redirect is proven before it is trusted ------------------------------
    const probed = execFileSync(process.execPath, ['-p', 'require("os").homedir()'], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    }).trim()
    expect(probed, 'HOME must redirect os.homedir(), or user scope would edit the real config').toBe(home)

    expect(realConfigHasDouze(), 'the real config already names douze; this spec cannot prove anything').toBe(false)
    const userRun = await runDouze(['mcp', 'add', '--agent', 'claude-code', '--scope', 'user'], {
      cwd: project,
      env: { HOME: home },
    })
    expect(userRun.code).toBe(0)

    const userReport = reported(userRun.out)
    expect(userReport.scope).toBe('user')
    // The scope reported is the file that changed: user scope is `~/.claude.json`, and `~` here
    // is the scratch home, so the user's real config cannot be what moved.
    expect(userReport.path).toBe(join(home, '.claude.json'))
    expect(realConfigHasDouze()).toBe(false)

    const userConfig = JSON.parse(readFileSync(userReport.path, 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(userConfig.mcpServers['douze']).toEqual({ type: 'stdio', command: 'douze', args: ['--mcp'] })
    // Project scope is a different file; writing user scope must not have touched it.
    expect(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8')).mcpServers.douze).toBeDefined()
  })

  test('@COV_CON_002.2 should register a reserved name under a suffix rather than failing', async () => {
    test.setTimeout(60_000)
    const project = scratch('cc-reserved')

    const run = await runDouze(
      ['mcp', 'add', '--agent', 'claude-code', '--scope', 'project', '--name', 'workspace'],
      { cwd: project },
    )

    // AC-CON-002.3 — reserved means renamed-and-registered, not refused.
    expect(run.code).toBe(0)
    expect(run.out).toMatch(/"workspace" is reserved by Claude Code/)

    const report = reported(run.out)
    expect(report.name).toBe('workspace-douze')

    const config = JSON.parse(readFileSync(report.path, 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(config.mcpServers['workspace-douze']).toEqual({ type: 'stdio', command: 'douze', args: ['--mcp'] })
    expect(config.mcpServers['workspace']).toBeUndefined()
  })

  test('@COV_CON_002.1 should produce a registration `claude mcp list` reports as connected', async () => {
    test.setTimeout(180_000)

    const home = scratch('cc-connected')
    const project = scratch('cc-connected-project')
    const douzed = new Douzed()

    // `douze` is not on PATH in a scratch environment, so the entry points at a launcher that
    // runs this checkout's CLI with the same `--mcp` argument the default entry carries. The
    // shape of the entry — the part AC-CON-002.1 fixes — is asserted in the test above.
    const launcher = join(home, 'douze-launcher.sh')
    writeFileSync(
      launcher,
      `#!/bin/sh\nexport DOUZE_HOME=${douzed.home}\nexec ${TSX} ${join(REPO, 'packages/cli/src/bin.ts')} "$@"\n`,
    )
    chmodSync(launcher, 0o755)

    try {
      const run = await runDouze(
        ['mcp', 'add', '--agent', 'claude-code', '--scope', 'user', '--command', launcher],
        { cwd: project, env: { HOME: home } },
      )
      expect(run.code).toBe(0)
      const report = reported(run.out)
      expect(report.path).toBe(join(home, '.claude.json'))

      const entry = (JSON.parse(readFileSync(report.path, 'utf8')) as { mcpServers: Record<string, unknown> })
        .mcpServers['douze'] as { type: string; command: string; args: string[] }
      expect(entry).toEqual({ type: 'stdio', command: launcher, args: ['--mcp'] })

      // AC-CON-002.2 — the real `claude` CLI reads the file this command wrote, starts the
      // server it names, and completes the MCP handshake against it.
      const claude = which('claude')
      test.skip(claude === null, 'the `claude` CLI is not installed on this machine')

      const listed = execFileSync(claude as string, ['mcp', 'list'], {
        cwd: project,
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
        timeout: 120_000,
      })
      expect(listed).toContain('douze')
      expect(listed).toMatch(/douze:.*Connected/)
    } finally {
      await douzed.stop()
    }
  })
})

/**
 * COV_CON_003.1 — a relayed call that outlives a minute reports progress and still returns.
 *
 * The PRD's scenario is a seven-minute call; what AC-CON-003.1 actually fixes is the INTERVAL —
 * "every 60 seconds until the call completes". So the fixture app is delayed just past one
 * interval: that is the shortest run that can distinguish "emits progress on schedule" from
 * "emits nothing", and seven minutes would test only the same code path six more times.
 */
const DELAY_MS = 75_000

const SLOW_RECIPE = `
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

interface Notification {
  method: string
  params?: { progressToken?: string | number; progress?: number; message?: string }
}

/** A minimal JSON-RPC-over-stdio client, so the assertion is on the wire, not on an abstraction. */
class McpClient {
  private readonly child: ChildProcess
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, (value: unknown) => void>()
  readonly notifications: Notification[] = []

  constructor(home: string) {
    this.child = spawn(TSX, [join(REPO, 'packages/cli/src/bin.ts'), '--mcp'], {
      env: { ...process.env, DOUZE_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout!.on('data', (chunk) => {
      this.buffer += String(chunk)
      for (const line of this.buffer.split('\n').slice(0, -1)) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown } & Notification
        if (message.method) this.notifications.push(message)
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

test.describe('COV_CON_003: Long-running calls', () => {
  let app: FixtureApp
  let douzed: Douzed
  let browser: Awaited<ReturnType<typeof launchHelium>>
  let client: McpClient

  test.afterAll(async () => {
    client?.kill()
    await browser?.dispose()
    await douzed?.stop()
    await app?.stop()
  })

  /**
   * AC-CON-003.1 — a relayed call waits on a human's browser, so silence past a minute reads as a
   * hang to the client. This originally failed: `startProgress` read its notifier from
   * `extra.sendNotification`, which does not exist on the context
   * `@modelcontextprotocol/server@2.0.0-alpha.4` hands a tool callback — the notifier is
   * `ctx.mcpReq.notify(...)`. One wrong property name disabled progress for every call of every
   * duration. Fixed in `packages/cli/src/mcp.ts`; this now asserts the real behaviour.
   */
  test('@COV_CON_003.1 should emit a progress notification while a slow call is outstanding', async () => {
    // One call that deliberately takes over a minute, plus a browser launch.
    test.setTimeout(300_000)

    app = new FixtureApp()
    await app.start()
    await app.reset()

    douzed = new Douzed()
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), SLOW_RECIPE)
    writeFileSync(join(douzed.fixturesDir, 'list_orders.json'), '{"data":{"orders":[]}}')
    await douzed.start()

    browser = await launchHelium()
    await browser.serviceWorker.evaluate(
      ([port, token]) => (globalThis as never as DouzeApi).__douze.connect(Number(port), String(token)),
      [String(douzed.port), douzed.token] as const,
    )

    const page: Page = await browser.context.newPage()
    await page.goto(app.origin)
    await page.evaluate(() => fetch('/login', { method: 'POST' }).then((r) => r.json()))
    await waitFor(async () => (await (await douzed.api('/health')).json()).extension_connected, 'extension socket')

    // The relay executes in a tab on the target origin, and the fixture page polls `/api/poll`
    // every second. Under a 75-second delay those pending polls would exhaust the per-origin
    // connection pool and the relayed request would queue behind them, so the executor tab is
    // parked on a script-free document of the same origin.
    await page.goto(`${app.origin}/app.css`)
    await app.reset()
    await app.set('delayMs', DELAY_MS)

    client = new McpClient(douzed.home)
    await client.initialize()
    await expect
      .poll(async () => (await client.request('tools/list')).tools.map((t: { name: string }) => t.name), {
        timeout: 30_000,
      })
      .toContain('orders_list_orders')

    const started = Date.now()
    const result = await client.request('tools/call', {
      name: 'orders_list_orders',
      arguments: {},
      // A client that wants progress supplies a token; the server reports against it.
      _meta: { progressToken: 'cov-con-003' },
    })
    const elapsed = Date.now() - started

    // The call really did outlive the 60-second interval, and it still returned.
    expect(elapsed).toBeGreaterThan(60_000)
    expect(result.isError ?? false).toBe(false)
    expect(JSON.stringify(result)).toContain('widget')

    // AC-CON-003.1 — at least one progress notification, carrying the caller's token.
    const progress = client.notifications.filter((n) => n.method === 'notifications/progress')
    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(progress[0]?.params?.progressToken).toBe('cov-con-003')
    expect(progress[0]?.params?.message).toContain('orders_list_orders')

    await app.set('delayMs', 0)
  })
})

function which(command: string): string | null {
  try {
    return execFileSync('which', [command], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

interface DouzeApi {
  __douze: { connect(port: number, token: string): Promise<void> }
}
