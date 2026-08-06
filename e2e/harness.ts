import { chromium, type BrowserContext, type Worker } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

/** A douzed instance rooted at a scratch DOUZE_HOME, so specs never touch a real install. */
export class Douzed {
  readonly home: string
  private process?: ChildProcess
  port = 0
  token = ''

  constructor() {
    this.home = mkdtempSync(join(tmpdir(), 'douze-home-'))
    // Specs stage recipes and fixtures before the daemon boots, so the dirs must exist first.
    for (const dir of ['recipes', 'fixtures']) mkdirSync(join(this.home, dir), { recursive: true })
  }

  get recipesDir(): string {
    return join(this.home, 'recipes')
  }

  get fixturesDir(): string {
    return join(this.home, 'fixtures')
  }

  async start(): Promise<void> {
    this.process = spawn(TSX, [join(REPO, 'packages/douzed/src/bin.ts')], {
      // DOUZE_PORT=0 keeps specs off the 8787-8791 range the shipped daemon walks. Without it
      // every scratch daemon — including the detached ones a client auto-starts, which inherit
      // this env — competes for 8787 with each other and with whatever is really running on the
      // developer's machine. The harness reads the port back from the runtime file regardless.
      env: { ...process.env, DOUZE_HOME: this.home, DOUZE_PORT: '0' },
      stdio: 'inherit',
    })
    await waitFor(async () => {
      const runtime = await this.runtime()
      if (!runtime) return false
      this.port = runtime.port
      return (await fetch(`http://127.0.0.1:${this.port}/health`)).ok
    }, 'douzed')
    this.token = (await import('node:fs')).readFileSync(join(this.home, 'token'), 'utf8').trim()
  }

  private async runtime(): Promise<{ port: number; pid: number } | null> {
    try {
      const fs = await import('node:fs')
      return JSON.parse(fs.readFileSync(join(this.home, 'douzed.json'), 'utf8'))
    } catch {
      return null
    }
  }

  api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: { 'x-douze-token': this.token, 'content-type': 'application/json', ...init.headers },
    })
  }

  /**
   * Awaited, like the fixture's: douzed now walks a fixed port range rather than taking an
   * ephemeral port, so a daemon still shutting down squats a port every later spec needs, and
   * five leaked ones fill the range outright.
   *
   * The detached kill is the load-bearing half. A client that auto-starts douzed spawns it
   * `detached` and unref'd (see DaemonClient.startDetached), so it is not `this.process` and
   * survives the kill below — the runtime file it wrote is the only handle anyone has on it.
   */
  async stop(): Promise<void> {
    const detached = (await this.runtime())?.pid
    if (this.process) {
      const exited = new Promise<void>((resolve) => this.process?.once('exit', () => resolve()))
      this.process.kill()
      await exited
      this.process = undefined as never
    }
    if (detached !== undefined && detached !== process.pid) await reap(detached)
    rmSync(this.home, { recursive: true, force: true })
  }
}

/** SIGTERM and then wait for the pid to actually go, so its port is free for the next spec. */
async function reap(pid: number, timeoutMs = 5_000): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // already gone
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 50))
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
