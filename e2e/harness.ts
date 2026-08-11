import { chromium, type BrowserContext, type Worker } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * WO-015 T-015.13 — what is left of the harness after the daemon went: the browser launcher, the
 * fixture app, a stdio MCP client, and `waitFor`. The `Douzed` class and `spawnMcp` booted
 * processes that no longer exist, so they and every spec that used them are gone; see
 * `e2e/README.md` for what T-015.14 has to put back.
 */
export const REPO = resolve(import.meta.dirname, '..')
export const HELIUM = '/Applications/Helium.app/Contents/MacOS/Helium'
export const EXTENSION = join(REPO, 'packages/extension/dist')
/** Resolved once: `npx` re-resolves on every spawn, which is seconds under a loaded suite. */
export const TSX = join(REPO, 'node_modules/.bin/tsx')

/**
 * Launches Helium with the unpacked Douze extension. Chromium 136+ (and Helium, which carries
 * the same guard) refuses remote debugging against the default profile, so every run gets a
 * scratch --user-data-dir. That also keeps the user's real session untouched.
 */
/**
 * The live-target suite needs a session that survives between runs, because signing in to a real
 * dashboard is a manual act. `DOUZE_E2E_PROFILE` points at a profile the user signs into once;
 * everything else gets a throwaway directory.
 */
export const LIVE_PROFILE = process.env['DOUZE_E2E_PROFILE'] ?? join(tmpdir(), 'douze-live-profile')

export async function launchHelium(
  extensionPath = EXTENSION,
  options: { profileDir?: string } = {},
): Promise<{ context: BrowserContext; serviceWorker: Worker; extensionId: string; dispose: () => Promise<void> }> {
  const persistent = options.profileDir !== undefined
  const userDataDir = options.profileDir ?? mkdtempSync(join(tmpdir(), 'douze-helium-'))
  mkdirSync(userDataDir, { recursive: true })
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: HELIUM,
    // MV3 service workers do not run under old headless.
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  let [serviceWorker] = context.serviceWorkers()
  serviceWorker ??= await context.waitForEvent('serviceworker', { timeout: 20_000 })

  return {
    context,
    serviceWorker,
    extensionId: new URL(serviceWorker.url()).host,
    dispose: async () => {
      await context.close()
      // A persistent profile holds a real signed-in session; never delete it.
      if (!persistent) rmSync(userDataDir, { recursive: true, force: true })
    },
  }
}

/** A server-initiated message. `params` carries progress, which COV_CON_003 asserts on. */
export interface Notification {
  method: string
  params?: { progressToken?: string | number; progress?: number; message?: string }
}

/**
 * A minimal JSON-RPC-over-stdio MCP client, so connector assertions are on the wire rather than
 * on an abstraction that could hide the handshake.
 */
export class McpClient {
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, (value: unknown) => void>()
  readonly notifications: Notification[] = []

  constructor(readonly child: ChildProcess) {
    this.child.stdout!.on('data', (chunk) => {
      this.buffer += String(chunk)
      for (const line of this.buffer.split('\n').slice(0, -1)) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as { id?: number; result?: unknown } & Notification
        if (message.method) this.notifications.push(message)
        else if (message.id !== undefined) this.pending.get(message.id)?.(message.result)
      }
      this.buffer = this.buffer.slice(this.buffer.lastIndexOf('\n') + 1)
    })
  }

  /** The methods seen, for a spec that only cares that a kind of notification arrived. */
  get notified(): string[] {
    return this.notifications.map((n) => n.method)
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- a JSON-RPC result is whatever the method returns
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
      clientInfo: { name: 'e2e-connector', version: '1.0.0' },
    })
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  }

  async tools(): Promise<string[]> {
    return ((await this.request('tools/list')).tools as { name: string }[]).map((t) => t.name)
  }

  /** The description is where a degraded tool announces itself to a client (AC-RUN-001.5). */
  async describe(name: string): Promise<string | undefined> {
    const listed = (await this.request('tools/list')).tools as { name: string; description: string }[]
    return listed.find((t) => t.name === name)?.description
  }

  kill(): void {
    this.child.kill()
  }
}

/** The fixture target app. Every spec asserts against what this server actually received. */
export class FixtureApp {
  private process?: ChildProcess

  constructor(readonly port = 4180) {}

  get origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /**
   * The port is fixed because the extension's e2e build bakes this exact origin into
   * `host_permissions`. That makes start/stop ordering load-bearing: if a previous instance
   * still holds the port, the new one fails to bind and specs silently talk to the old server
   * with the old control-flag state. So: wait for the port to be free, then for OUR server.
   */
  async start(): Promise<void> {
    await waitFor(async () => !(await this.responding()), `port ${this.port} to be free`)
    this.process = spawn(TSX, [join(REPO, 'fixtures/server.ts')], {
      env: { ...process.env, FIXTURE_PORT: String(this.port) },
      stdio: 'ignore',
    })
    await waitFor(() => this.responding(), 'fixture app')
  }

  private async responding(): Promise<boolean> {
    try {
      return (await fetch(`${this.origin}/__test/log`)).ok
    } catch {
      return false
    }
  }

  /** Requests the app saw. The basis for "zero requests were issued" assertions. */
  async log(): Promise<{ method: string; path: string; headers: Record<string, string> }[]> {
    return (await fetch(`${this.origin}/__test/log`)).json()
  }

  async reset(): Promise<void> {
    await fetch(`${this.origin}/__test/reset`)
  }

  /** Flip a control: sessionValid, widenResponse, breakResponse, delayMs, pageStateAuth. */
  async set(key: string, value: unknown): Promise<void> {
    await fetch(`${this.origin}/__test/${key}?value=${encodeURIComponent(JSON.stringify(value))}`)
  }

  /** Awaited, so the next spec's start() cannot race a process still holding the port. */
  async stop(): Promise<void> {
    if (!this.process) return
    const exited = new Promise<void>((resolve) => this.process!.once('exit', () => resolve()))
    this.process.kill()
    await exited
    this.process = undefined as never
  }
}

export async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}
