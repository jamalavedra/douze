import { spawn } from 'node:child_process'
import { installToken, isAlive, readRuntime, type RegistryState, type RuntimeInfo } from '@recon/recond'
import type { Recipe } from '@recon/shared'
import { relayUnreachable } from './errors.js'

/** Where the relay lives and what proves this client may talk to it. */
export interface Endpoint {
  origin: string
  token: string
}

/**
 * The client half of the loopback contract. Everything the CLI and the MCP server know about
 * recond goes through here: the install token, the runtime file, and AC-RUN-003.3 — if recond
 * is not running, start it and proceed once it answers.
 */
export class DaemonClient {
  private cached: RuntimeInfo | null = null

  constructor(private readonly options: { autoStart?: boolean } = {}) {}

  /**
   * AC-RUN-003.4 — resolving the endpoint before every call is what makes recovery after a
   * daemon restart automatic: a dead pid is a daemon to start again, not an error to report.
   *
   * AC-CON-001.2 — an MCPB install has no runtime file to read, so the settings form's values
   * arrive as environment variables and win when present.
   */
  async resolve(): Promise<Endpoint> {
    const configured = process.env['RECON_RELAY_URL']
    if (configured) {
      return {
        origin: configured.replace(/\/+$/, ''),
        token: process.env['RECON_INSTALL_TOKEN'] ?? installToken(),
      }
    }

    if (isAlive(this.cached)) return local(this.cached)
    const running = readRuntime()
    if (isAlive(running)) {
      this.cached = running
      return local(running)
    }
    if (this.options.autoStart === false) throw relayUnreachable('no running instance')
    this.cached = await startDetached()
    return local(this.cached)
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const endpoint = await this.resolve()
    let response: Response
    try {
      response = await fetch(`${endpoint.origin}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-recon-token': endpoint.token, ...init.headers },
      })
    } catch (cause) {
      // The daemon went away mid-flight. AC-CON-004.4 — report it; the next call restarts it.
      this.cached = null
      throw relayUnreachable((cause as Error).message)
    }
    const body = (await response.json().catch(() => ({}))) as T
    if (!response.ok) {
      const error = new DaemonHttpError(response.status)
      error.body = body
      throw error
    }
    return body
  }

  registry(): Promise<RegistryState> {
    return this.request<RegistryState>('/registry')
  }

  recipes(): Promise<Recipe[]> {
    return this.request<Recipe[]>('/recipes')
  }

  health(): Promise<{ ok: boolean; extension_connected: boolean }> {
    return this.request('/health')
  }
}

const local = (runtime: RuntimeInfo): Endpoint => ({
  origin: `http://127.0.0.1:${runtime.port}`,
  token: installToken(),
})

/** Carries the daemon's `{error, message, ...}` body up to `errors.fromDaemon`. */
export class DaemonHttpError extends Error {
  body: unknown = undefined
  constructor(readonly status: number) {
    super(`recond returned HTTP ${status}`)
    this.name = 'DaemonHttpError'
  }
}

/**
 * AC-RUN-003.1 — recond outlives whichever client started it, so it is spawned detached rather
 * than hosted in-process. `RECON_ENTRY` exists because a bundled CLI and a test harness disagree
 * about what `argv[1]` is.
 */
export async function startDetached(timeoutMs = 15_000): Promise<RuntimeInfo> {
  const entry = process.env['RECON_ENTRY'] ?? process.argv[1]
  if (!entry) throw relayUnreachable('cannot locate the recon entry point to start recond')

  // Re-exec with this process's own execArgv so a TypeScript entry point started under `tsx`
  // spawns the daemon under `tsx` too; a bundled `dist/index.js` has an empty execArgv.
  const child = spawn(process.execPath, [...process.execArgv, entry, 'start'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, RECON_FOREGROUND: '1' },
  })
  child.unref()

  return waitForDaemon(timeoutMs)
}

/** AC-RUN-003.3 — "proceed once the relay is reachable", not once the process exists. */
export async function waitForDaemon(timeoutMs = 15_000): Promise<RuntimeInfo> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const runtime = readRuntime()
    if (isAlive(runtime) && (await reachable(runtime))) return runtime
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw relayUnreachable(`recond did not become reachable within ${timeoutMs}ms`)
}

async function reachable(runtime: RuntimeInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/health`)
    return response.ok
  } catch {
    return false
  }
}
