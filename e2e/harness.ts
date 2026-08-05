import { chromium, type BrowserContext, type Worker } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const REPO = resolve(import.meta.dirname, '..')
export const HELIUM = '/Applications/Helium.app/Contents/MacOS/Helium'
export const EXTENSION = join(REPO, 'packages/extension/dist')

/**
 * Launches Helium with the unpacked Recon extension. Chromium 136+ (and Helium, which carries
 * the same guard) refuses remote debugging against the default profile, so every run gets a
 * scratch --user-data-dir. That also keeps the user's real session untouched.
 */
/**
 * The live-target suite needs a session that survives between runs, because signing in to a real
 * dashboard is a manual act. `RECON_E2E_PROFILE` points at a profile the user signs into once;
 * everything else gets a throwaway directory.
 */
export const LIVE_PROFILE = process.env['RECON_E2E_PROFILE'] ?? join(tmpdir(), 'recon-live-profile')

export async function launchHelium(
  extensionPath = EXTENSION,
  options: { profileDir?: string } = {},
): Promise<{ context: BrowserContext; serviceWorker: Worker; extensionId: string; dispose: () => Promise<void> }> {
  const persistent = options.profileDir !== undefined
  const userDataDir = options.profileDir ?? mkdtempSync(join(tmpdir(), 'recon-helium-'))
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

  async start(): Promise<void> {
    this.process = spawn('npx', ['tsx', join(REPO, 'fixtures/server.ts')], {
      env: { ...process.env, FIXTURE_PORT: String(this.port) },
      stdio: 'ignore',
    })
    await waitFor(async () => (await fetch(`${this.origin}/__test/log`)).ok, 'fixture app')
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

  stop(): void {
    this.process?.kill()
  }
}

/** A recond instance rooted at a scratch RECON_HOME, so specs never touch a real install. */
export class Recond {
  readonly home: string
  private process?: ChildProcess
  port = 0
  token = ''

  constructor() {
    this.home = mkdtempSync(join(tmpdir(), 'recon-home-'))
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
    this.process = spawn('npx', ['tsx', join(REPO, 'packages/recond/src/bin.ts')], {
      env: { ...process.env, RECON_HOME: this.home },
      stdio: 'inherit',
    })
    await waitFor(async () => {
      const runtime = await this.runtime()
      if (!runtime) return false
      this.port = runtime.port
      return (await fetch(`http://127.0.0.1:${this.port}/health`)).ok
    }, 'recond')
    this.token = (await import('node:fs')).readFileSync(join(this.home, 'token'), 'utf8').trim()
  }

  private async runtime(): Promise<{ port: number; pid: number } | null> {
    try {
      const fs = await import('node:fs')
      return JSON.parse(fs.readFileSync(join(this.home, 'recond.json'), 'utf8'))
    } catch {
      return null
    }
  }

  api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: { 'x-recon-token': this.token, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  }

  stop(): void {
    this.process?.kill()
    rmSync(this.home, { recursive: true, force: true })
  }
}

export async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
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
