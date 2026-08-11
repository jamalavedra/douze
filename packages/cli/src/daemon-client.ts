import { spawn } from 'node:child_process'
import {
  installToken,
  isAlive,
  readRuntime,
  startDaemon,
  type Daemon,
  type RegistryState,
  type RuntimeInfo,
} from '@douze/douzed'
import { PORT_RANGE, type Recipe } from '@douze/shared'
import { relayUnreachable } from './errors.js'

/** Where the relay lives and what proves this client may talk to it. */
export interface Endpoint {
  origin: string
  token: string
}

/**
 * Whether a daemon this process needs is one it runs itself.
 *
 * Process-global because the question is about the process: `status` and `sessions` build their
 * own client inside a command handler, and inside `douze --mcp` those must host like every other
 * call rather than re-exec a Node that may not exist. A terminal leaves it false, so a one-shot
 * command still detaches a daemon that outlives it.
 */
let hostByDefault = false
export const hostDaemonInProcess = (): void => {
  hostByDefault = true
}

/**
 * The client half of the loopback contract. Everything the CLI and the MCP server know about
 * douzed goes through here: the install token, the runtime file, and AC-RUN-003.3 — if douzed
 * is not running, start it and proceed once it answers.
 */
export class DaemonClient {
  private cached: RuntimeInfo | null = null

  constructor(private readonly options: { autoStart?: boolean } = {}) {}

  /**
   * AC-RUN-003.4 — resolving the endpoint before every call is what makes recovery after a
   * daemon restart automatic: a dead pid is a daemon to start again, not an error to report.
   *
   * An install configures nothing: with no environment set, the runtime file is read and the
   * daemon started if it is down. `DOUZE_RELAY_URL`/`DOUZE_INSTALL_TOKEN` remain as an override
   * for pointing a client at a daemon it did not start — a second `DOUZE_HOME`, or a test.
   */
  async resolve(): Promise<Endpoint> {
    const configured = process.env['DOUZE_RELAY_URL']
    if (configured) {
      return {
        origin: configured.replace(/\/+$/, ''),
        token: process.env['DOUZE_INSTALL_TOKEN'] ?? installToken(),
      }
    }

    if (isAlive(this.cached)) return local(this.cached)
    const running = readRuntime()
    if (isAlive(running)) {
      this.cached = running
      return local(running)
    }
    if (this.options.autoStart === false) throw relayUnreachable('no running instance')
    this.cached = hostByDefault ? await hostOrAdopt() : await startDetached()
    return local(this.cached)
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const endpoint = await this.resolve()
    let response: Response
    try {
      response = await fetch(`${endpoint.origin}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-douze-token': endpoint.token, ...init.headers },
      })
    } catch (cause) {
      // The daemon went away mid-flight. AC-CON-004.4 — report it; the next call restarts it.
      this.cached = null
      throw relayUnreachable((cause as Error).message)
    }
    const body = (await response.json().catch(() => ({}))) as T
    if (!response.ok) {
      // Also drops the cache. A cached endpoint that answers but answers wrongly — the daemon
      // restarted and reissued its token, or the port was taken over by something else entirely —
      // stayed cached forever, because only a network throw ever cleared it. Re-resolving costs
      // one runtime-file read on the next call.
      this.cached = null
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
    super(`douzed returned HTTP ${status}`)
    this.name = 'DaemonHttpError'
  }
}

/**
 * The daemon this process runs itself, if it is the one that got there first. Held so a second
 * `resolve()` adopts it instead of binding a second port.
 */
let hosted: Daemon | null = null

/**
 * How `douze --mcp` gets a daemon: adopt one if it is already up, otherwise run it here.
 *
 * Re-exec is not available to the MCP process. Claude Desktop runs it in an Electron
 * UtilityProcess, where `process.execPath` is the Claude binary and there is no node to spawn —
 * `startDetached` there launches the app, waits out its timeout, and dies without ever answering
 * `initialize`. Hosting the daemon in-process needs no node binary and no install step, and works
 * the same in every MCP client.
 *
 * The cost is deliberate: the daemon lives as long as the client that started it. A second client
 * adopts this one over loopback, and takes over hosting once this process is gone.
 */
export async function hostOrAdopt(): Promise<RuntimeInfo> {
  if (hosted) return runtimeOf(hosted.port)
  const adopted = await probe()
  if (adopted) return adopted
  try {
    hosted = await startDaemon()
    return runtimeOf(hosted.port)
  } catch (cause) {
    // Lost a race with another client between the probe and the bind. Theirs is as good as ours.
    const winner = await probe()
    if (winner) return winner
    throw relayUnreachable((cause as Error).message)
  }
}

/** The ports a daemon can be on: whichever one it recorded, then the range it walks. */
export async function probe(): Promise<RuntimeInfo | null> {
  const recorded = readRuntime()
  const ports = [...new Set([...(recorded ? [recorded.port] : []), ...PORT_RANGE])]
  for (const port of ports) {
    if (await reachablePort(port)) return runtimeOf(port)
  }
  return null
}

/**
 * A daemon we did not start has a pid we cannot know from a port alone, and `isAlive` is what
 * `resolve` caches on. Our own pid stands in: a daemon that goes away is caught by the failed
 * request that follows, which drops the cache and resolves again.
 */
const runtimeOf = (port: number): RuntimeInfo => {
  const recorded = readRuntime()
  return recorded?.port === port ? recorded : { pid: process.pid, port, started_at: Date.now() }
}

/**
 * Whether a *douzed* answers on this port. A bare 200 is not enough: RStudio Server and
 * `wrangler dev` both default to 8787 and answer almost any path, and adopting one as the daemon
 * meant handing it this install's token and then caching it as the endpoint for good. The body has
 * to name itself, and a redirect is not followed — a service bouncing /health to a page that 200s
 * would otherwise answer for it.
 */
const reachablePort = async (port: number): Promise<boolean> => {
  try {
    // Bounded: something that holds the port without answering — RStudio Server is the usual
    // one — would otherwise stall the probe, and with it the whole MCP server's first refresh.
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(500),
    })
    return response.ok && isDouzedHealth(await response.json())
  } catch {
    return false
  }
}

const isDouzedHealth = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && 'ok' in body && 'extension_connected' in body

/**
 * A cold auto-start pays for the runtime compiling the daemon entry point, and on a loaded or
 * slow machine that is well past 15 s. The old ceiling turned a slow first run into a hard
 * failure of `douze status`; the wait is cheap and only ever ends early.
 */
export const DAEMON_START_TIMEOUT_MS = Number(process.env['DOUZE_START_TIMEOUT_MS'] ?? 45_000)

/**
 * AC-RUN-003.1 — for a terminal, douzed outlives the command that started it, so it is spawned
 * detached. `DOUZE_ENTRY` exists because a bundled CLI and a test harness disagree about what
 * `argv[1]` is. The MCP process cannot use this path at all (see `hostOrAdopt`).
 */
export async function startDetached(timeoutMs = DAEMON_START_TIMEOUT_MS): Promise<RuntimeInfo> {
  const entry = process.env['DOUZE_ENTRY'] ?? process.argv[1]
  if (!entry) throw relayUnreachable('cannot locate the douze entry point to start douzed')

  // Re-exec with this process's own execArgv so a TypeScript entry point started under `tsx`
  // spawns the daemon under `tsx` too; a bundled `dist/index.js` has an empty execArgv.
  const child = spawn(process.execPath, [...process.execArgv, entry, 'start'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DOUZE_FOREGROUND: '1' },
  })
  child.unref()

  return waitForDaemon(timeoutMs)
}

/** AC-RUN-003.3 — "proceed once the relay is reachable", not once the process exists. */
async function waitForDaemon(timeoutMs = DAEMON_START_TIMEOUT_MS): Promise<RuntimeInfo> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const runtime = readRuntime()
    if (isAlive(runtime) && (await reachable(runtime))) return runtime
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw relayUnreachable(`douzed did not become reachable within ${timeoutMs}ms`)
}

async function reachable(runtime: RuntimeInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/health`)
    return response.ok
  } catch {
    return false
  }
}
