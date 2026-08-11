import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'incur'
import { isAlive, readRuntime, startDaemon } from '@douze/douzed'
import { DEFAULT_PORT, PORT_RANGE } from '@douze/shared'
import { DaemonClient, startDetached } from '../daemon-client.js'
import { readRelayConfig, readRemoteAudit, startRemoteBridge } from '../remote-bridge.js'

type ErrorFn = (options: { code: string; message: string; exitCode?: number }) => never

/**
 * Daemon lifecycle and read-only inspection. These are the only commands that must work with no
 * recipes, no extension, and no browser, so they are registered before any recipe group.
 */
export function register(cli: { command: (name: string, definition: unknown) => unknown }): void {
  cli.command('start', {
    description: 'Start the Douze relay daemon (douzed)',
    options: z.object({
      // Left unset, douzed walks PORT_RANGE — the ports the extension probes — and only then an
      // ephemeral one. Naming a port here means you want that port: it binds or it fails.
      port: z.number().int().optional().describe('Port for the relay to bind'),
    }),
    mcp: false,
    async run(c: { options: { port?: number }; error: ErrorFn }) {
      // The detached child re-enters here with DOUZE_FOREGROUND set and never returns.
      if (process.env['DOUZE_FOREGROUND'] === '1') return runForeground(c.options.port, c.error)

      const running = readRuntime()
      // Auto-start is the norm now — the MCP server hosts the daemon when its client
      // launches — so finding one already up is the expected outcome of asking for one, not a
      // failure. AC-RUN-003.2 still holds where it matters: `runForeground` refuses to bind a
      // second time, so this reports the first instance instead of racing it.
      if (isAlive(running)) return { started: false, pid: running.pid, port: running.port }
      // The daemon runs in a detached child, so the flag has to travel to it the way DOUZE_PORT
      // already does — the child inherits this environment. Without it `--port` bound nothing.
      if (c.options.port !== undefined) process.env['DOUZE_PORT'] = String(c.options.port)
      const runtime = await startDetached()
      return { started: true, pid: runtime.pid, port: runtime.port }
    },
  })

  cli.command('stop', {
    description: 'Stop the Douze relay daemon',
    mcp: false,
    run(c: { error: ErrorFn }) {
      const running = readRuntime()
      if (!isAlive(running)) return c.error({ code: 'NOT_RUNNING', message: 'douzed is not running.', exitCode: 1 })
      process.kill(running.pid, 'SIGTERM')
      return { stopped: true, pid: running.pid }
    },
  })

  cli.command('status', {
    description: 'Report daemon, extension, and tool-surface state',
    mcp: { annotations: { readOnlyHint: true } },
    async run() {
      // AC-RUN-003.3/.4 — status starts douzed if it is down and reports the daemon that is up
      // afterwards, so a killed daemon is recovered by the next command with no user action.
      const daemon = new DaemonClient()
      const [health, registry] = await Promise.all([daemon.health(), daemon.registry()])
      const running = readRuntime()
      return {
        running: isAlive(running),
        pid: running?.pid,
        port: running?.port,
        // The extension probes PORT_RANGE and nothing else. Inside the range this is a note;
        // outside it the extension will never find the daemon, which is the only real failure.
        ...(running && running.port !== DEFAULT_PORT
          ? {
              port_warning: (PORT_RANGE as readonly number[]).includes(running.port)
                ? `Something else is using ${DEFAULT_PORT}, so Douze took ${running.port}. The Chrome extension still finds it.`
                : `Douze is on port ${running.port}, which the Chrome extension does not check. Free up one of ` +
                  `${PORT_RANGE.join(', ')} and restart Douze, or the extension will report it as not running.`,
            }
          : {}),
        extension_connected: health.extension_connected,
        revision: registry.revision,
        tools: registry.tools.length,
        // AC-REC-001.4 — a recipe that failed to load is named here rather than disappearing.
        degraded: registry.tools.filter((t) => t.degraded).map((t) => t.qualified_name),
        errors: registry.errors,
        // T-014.3 — what the remote path has been asked to do, readable without a log file.
        ...(readRelayConfig() ? { remote: { configured: true, recent_calls: readRemoteAudit(5) } } : {}),
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
async function runForeground(port: number | undefined, error: ErrorFn): Promise<never> {
  let daemon
  try {
    // No probe-then-bind here: startDaemon walks the range itself, and a probe would only add a
    // window for something else to take the port between the check and the bind.
    daemon = await startDaemon(port === undefined ? {} : { port })
  } catch (cause) {
    return error({ code: 'ALREADY_RUNNING', message: (cause as Error).message, exitCode: 1 })
  }
  // WO-014 — the outbound bridge to a relay, if `douze connect` paired one. It dials out and
  // opens no listener, and a relay that is down costs a reconnect loop and nothing else, so the
  // daemon is up and serving loopback whatever the relay is doing.
  const relayConfig = readRelayConfig()
  const bridge = relayConfig ? startRemoteBridge(new DaemonClient(), relayConfig) : null

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      bridge?.close()
      void daemon.close().then(() => process.exit(0))
    })
  }
  await new Promise(() => undefined)
  throw new Error('unreachable')
}
