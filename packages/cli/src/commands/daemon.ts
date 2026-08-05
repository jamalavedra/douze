import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { z } from 'incur'
import { isAlive, readRuntime, startDaemon } from '@recon/recond'
import { DEFAULT_PORT } from '@recon/shared'
import { DaemonClient, startDetached, waitForDaemon } from '../daemon-client.js'

type ErrorFn = (options: { code: string; message: string; exitCode?: number }) => never

/**
 * Daemon lifecycle and read-only inspection. These are the only commands that must work with no
 * recipes, no extension, and no browser, so they are registered before any recipe group.
 */
export function register(cli: { command: (name: string, definition: unknown) => unknown }): void {
  cli.command('start', {
    description: 'Start the Recon relay daemon (recond)',
    options: z.object({
      // AC-CON-001.2 — an installed .mcpb holds the relay URL the user typed into a form once,
      // so the daemon has to come back on the same port every time rather than an ephemeral one.
      port: z.number().int().default(DEFAULT_PORT).describe('Port for the relay to bind'),
    }),
    mcp: false,
    async run(c: { options: { port: number }; error: ErrorFn }) {
      // The detached child re-enters here with RECON_FOREGROUND set and never returns.
      if (process.env['RECON_FOREGROUND'] === '1') return runForeground(c.options.port, c.error)

      const running = readRuntime()
      // AC-RUN-003.2 — a second daemon reports the first rather than binding another port.
      if (isAlive(running)) {
        return c.error({
          code: 'ALREADY_RUNNING',
          message: `recond is already running (pid ${running.pid}, port ${running.port}).`,
          exitCode: 1,
        })
      }
      const runtime = await startDetached()
      return { started: true, pid: runtime.pid, port: runtime.port }
    },
  })

  cli.command('stop', {
    description: 'Stop the Recon relay daemon',
    mcp: false,
    run(c: { error: ErrorFn }) {
      const running = readRuntime()
      if (!isAlive(running)) return c.error({ code: 'NOT_RUNNING', message: 'recond is not running.', exitCode: 1 })
      process.kill(running.pid, 'SIGTERM')
      return { stopped: true, pid: running.pid }
    },
  })

  cli.command('status', {
    description: 'Report daemon, extension, and tool-surface state',
    mcp: { annotations: { readOnlyHint: true } },
    async run() {
      // AC-RUN-003.3/.4 — status starts recond if it is down and reports the daemon that is up
      // afterwards, so a killed daemon is recovered by the next command with no user action.
      const daemon = new DaemonClient()
      const [health, registry] = await Promise.all([daemon.health(), daemon.registry()])
      const running = readRuntime()
      return {
        running: isAlive(running),
        pid: running?.pid,
        port: running?.port,
        extension_connected: health.extension_connected,
        revision: registry.revision,
        tools: registry.tools.length,
        // AC-REC-001.4 — a recipe that failed to load is named here rather than disappearing.
        degraded: registry.tools.filter((t) => t.degraded).map((t) => t.qualified_name),
        errors: registry.errors,
      }
    },
  })

  cli.command('sessions', {
    description: 'List recorded capture sessions',
    mcp: { annotations: { readOnlyHint: true } },
    run: () => new DaemonClient().request('/sessions'),
  })

  cli.command('import', {
    description: 'Import a HAR file as a capture session',
    args: z.object({ file: z.string().describe('Path to a .har file') }),
    options: z.object({ name: z.string().describe('Name for the created session') }),
    mcp: false,
    async run(c: { args: { file: string }; options: { name: string }; error: ErrorFn }) {
      const path = resolve(c.args.file)
      let har: unknown
      try {
        har = JSON.parse(readFileSync(path, 'utf8'))
      } catch (cause) {
        return c.error({ code: 'BAD_HAR', message: `Could not read ${path}: ${(cause as Error).message}`, exitCode: 1 })
      }
      return new DaemonClient().request('/import/har', {
        method: 'POST',
        body: JSON.stringify({ har, name: c.options.name }),
      })
    },
  })
}

/** The daemon process itself: start, write the runtime file, and stay up until signalled. */
async function runForeground(port: number, error: ErrorFn): Promise<never> {
  let daemon
  try {
    daemon = await startDaemon({ port: await bindable(port) })
  } catch (cause) {
    return error({ code: 'ALREADY_RUNNING', message: (cause as Error).message, exitCode: 1 })
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void daemon.close().then(() => process.exit(0))
    })
  }
  await new Promise(() => undefined)
  throw new Error('unreachable')
}

/**
 * Returns `port` if it is free, else 0 for an ephemeral one. A second `RECON_HOME` — an E2E
 * scratch root alongside a real install — is still entitled to a daemon, and every client reads
 * the port back out of `recond.json`, so only the `.mcpb` default URL can go stale.
 *
 * The probe is here rather than a catch around `startDaemon` because recond's WebSocketServer
 * emits EADDRINUSE as an unhandled error event that takes the process down first.
 *
 * ponytail: probe-then-bind races if something takes the port in between. The loser is a
 * daemon that fails to start and is retried by the next command; a retry loop is not worth it.
 */
async function bindable(port: number): Promise<number> {
  if (port === 0) return 0
  const probe = createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(0))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)))
  })
}

export { waitForDaemon }
