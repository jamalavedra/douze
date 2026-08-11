import { rmSync } from 'node:fs'
import { z } from 'incur'
import { isAlive, readRuntime } from '@douze/douzed'
import { startDetached } from '../daemon-client.js'
import { readRelayConfig, relayConfigPath, writeRelayConfig, type RelayConfig } from '../remote-bridge.js'

type ErrorFn = (options: { code: string; message: string; exitCode?: number }) => never

const VERSION = '0.1.0'

/**
 * WO-014 — pairing with a relay, which is the whole of the remote setup: one command writes the
 * token, one prints the URL to paste, and the daemon dials out from there. No listener is opened
 * on this machine and nothing else has to be configured.
 *
 * The MCP URL is the credential (the secret is the path), so it is printed once, here, in the
 * user's own terminal, and stored mode 0600.
 */
export function register(cli: { command: (name: string, definition: unknown) => unknown }): void {
  cli.command('connect', {
    description: 'Pair this daemon with a Douze relay so hosted chat clients can reach it',
    args: z.object({
      url: z.string().optional().describe('Relay base URL (defaults to $DOUZE_RELAY_URL)'),
    }),
    options: z.object({
      rotate: z.boolean().default(false).describe('Issue a new token and MCP URL, invalidating the old pair'),
      allowWrites: z.boolean().default(false).describe('Allow write tools on the remote surface'),
      bearer: z.string().optional().describe('Bearer token the relay should require from the platform'),
    }),
    mcp: false,
    async run(c: {
      args: { url?: string }
      options: { rotate: boolean; allowWrites: boolean; bearer?: string }
      error: ErrorFn
    }) {
      const existing = readRelayConfig()
      if (c.options.rotate && !existing) {
        return c.error({
          code: 'NOT_CONNECTED',
          message: 'Nothing to rotate: no relay is configured. Run `douze connect <url>` first.',
          exitCode: 1,
        })
      }
      const url = (c.args.url ?? process.env['DOUZE_RELAY_URL'] ?? existing?.url ?? '').replace(/\/+$/, '')
      if (!url) {
        return c.error({
          code: 'NO_RELAY_URL',
          message: 'Give a relay URL: `douze connect https://relay.example`, or set DOUZE_RELAY_URL.',
          exitCode: 1,
        })
      }

      let issued: { token: string; mcp_path: string }
      try {
        issued = await pair(url, c.options, existing)
      } catch (cause) {
        return c.error({ code: 'RELAY_REFUSED', message: (cause as Error).message, exitCode: 1 })
      }

      // A rotate keeps the connection's settings; only the secrets change.
      const previous = c.options.rotate ? existing : null
      const config: RelayConfig = {
        url,
        token: issued.token,
        mcp_path: issued.mcp_path,
        allow_writes: c.options.allowWrites || previous?.allow_writes === true,
        ...(c.options.bearer ? { bearer: true } : previous?.bearer ? { bearer: true } : {}),
        ...(previous?.expose ? { expose: previous.expose } : {}),
      }
      writeRelayConfig(config)

      const restarted = await restartDaemon()
      process.stdout.write(instructions(config, restarted))
      return {
        connected: true,
        url,
        mcp_url: `${url}${issued.mcp_path}`,
        allow_writes: config.allow_writes,
        daemon_restarted: restarted,
      }
    },
  })

  cli.command('disconnect', {
    description: 'Revoke this daemon’s relay pairing and stop serving hosted clients',
    mcp: false,
    async run(c: { error: ErrorFn }) {
      const config = readRelayConfig()
      if (!config) {
        return c.error({ code: 'NOT_CONNECTED', message: 'No relay is configured.', exitCode: 1 })
      }
      // Best effort: a relay that cannot be reached must not leave the local pairing in place,
      // because the daemon would keep dialling it. The token is dead here either way.
      let revoked = true
      try {
        const response = await fetch(`${config.url}/register`, {
          method: 'DELETE',
          headers: { 'x-douze-relay-token': config.token },
        })
        revoked = response.ok
        if (!revoked) warn(`the relay answered HTTP ${response.status} to the revoke; the local pairing was removed.`)
      } catch (cause) {
        revoked = false
        warn(`could not reach ${config.url} to revoke the token — ${(cause as Error).message}. Removed it locally.`)
      }

      rmSync(relayConfigPath(), { force: true })
      const restarted = await restartDaemon()
      return { disconnected: true, revoked, daemon_restarted: restarted }
    },
  })
}

/** POST /register, or POST /rotate when replacing a pair the relay still knows about. */
async function pair(
  url: string,
  options: { rotate: boolean; bearer?: string },
  existing: RelayConfig | null,
): Promise<{ token: string; mcp_path: string }> {
  const response =
    options.rotate && existing
      ? await fetch(`${url}/rotate`, { method: 'POST', headers: { 'x-douze-relay-token': existing.token } })
      : await fetch(`${url}/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            daemon_version: VERSION,
            ...(options.bearer ? { bearer_token: options.bearer } : {}),
          }),
        })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status} to the pairing request.`)

  const body = (await response.json().catch(() => ({}))) as { token?: unknown; mcp_path?: unknown }
  if (typeof body.token !== 'string' || typeof body.mcp_path !== 'string') {
    throw new Error(`${url} did not return a token and an MCP path; it may not be a Douze relay.`)
  }
  return { token: body.token, mcp_path: body.mcp_path }
}

/**
 * The bridge is read from disk when the daemon starts, so a pairing change only takes effect on
 * a restart. Doing it here means the user never has to be told to do it.
 */
async function restartDaemon(): Promise<boolean> {
  const running = readRuntime()
  if (!isAlive(running)) return false
  process.kill(running.pid, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while (isAlive(readRuntime()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await startDetached()
  return true
}

/**
 * T-014.7 — the command output is the onboarding. Every client below takes the same
 * streamable-HTTP URL; the differences are where the paste box lives, not what goes in it.
 */
function instructions(config: RelayConfig, restarted: boolean): string {
  return [
    `Connected to ${config.url}.`,
    '',
    'Your MCP URL — treat it as a password, anyone holding it can call these tools:',
    `  ${config.url}${config.mcp_path}`,
    '',
    'Paste it into your client:',
    '  ChatGPT    Settings → Connectors → Developer Mode → add a connector',
    '  claude.ai  Settings → Connectors → Add custom connector',
    `  Dust       Admin → Tools → Add MCP server${config.bearer ? ' (with the bearer token you passed)' : ''}`,
    '',
    config.allow_writes
      ? 'Remote clients can call read and write tools. Destructive tools are never callable remotely.'
      : 'Remote clients can call read tools only. Re-run with --allow-writes to add write tools;' +
        ' destructive tools are never callable remotely.',
    'The relay operator can read and inject traffic on this path, and the platform stores whatever',
    'your tools return — which is live data from your dashboards. Run your own relay with',
    'DOUZE_RELAY_URL if that is not acceptable.',
    restarted ? 'Restarted douzed, which is now connected.' : 'Start douzed with `douze start` to connect it.',
    '',
  ].join('\n')
}

const warn = (message: string): void => {
  process.stderr.write(`douze: ${message}\n`)
}
