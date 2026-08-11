import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { register } from './commands/connect.js'
import type { RelayConfig } from './remote-bridge.js'

/**
 * WO-014 T-014.2 — `douze connect` against a fake relay speaking the registration contract, with
 * a scratch DOUZE_HOME. The command handlers are taken straight off the registration call, so the
 * definitions the CLI mounts are the ones under test.
 */

interface Options {
  rotate: boolean
  allowWrites: boolean
  bearer?: string
}

interface CommandDefinition {
  run: (context: {
    args: { url?: string }
    options: Options
    error: (options: { code: string; message: string }) => never
  }) => Promise<unknown>
}

const commands = new Map<string, CommandDefinition>()
register({ command: (name, definition) => commands.set(name, definition as CommandDefinition) })

const fail = (options: { code: string; message: string }): never => {
  throw new Error(`${options.code}: ${options.message}`)
}

const run = (name: string, args: { url?: string } = {}, options: Partial<Options> = {}): Promise<unknown> =>
  commands.get(name)!.run({ args, options: { rotate: false, allowWrites: false, ...options }, error: fail } as never)

let home: string
let server: Server
let url: string
const requests: { method: string; path: string; token?: string; body: string }[] = []
let bearerSeen: unknown

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'douze-connect-'))
  process.env['DOUZE_HOME'] = home
  delete process.env['DOUZE_REMOTE_URL']

  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += String(chunk)))
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        ...(typeof request.headers['x-douze-relay-token'] === 'string'
          ? { token: request.headers['x-douze-relay-token'] }
          : {}),
        body,
      })
      if (request.method === 'DELETE') return response.writeHead(204).end()
      if (request.url === '/rotate') {
        return response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ token: 'token-2', mcp_path: '/mcp/second-secret' }),
        )
      }
      bearerSeen = (JSON.parse(body) as { bearer_token?: unknown }).bearer_token
      response
        .writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ token: 'token-1', mcp_path: '/mcp/first-secret' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterAll(() => {
  vi.restoreAllMocks()
  server.close()
  delete process.env['DOUZE_HOME']
})

const configFile = (): string => join(home, 'relay.json')
const config = (): RelayConfig => JSON.parse(readFileSync(configFile(), 'utf8')) as RelayConfig

describe('douze connect', () => {
  it('registers, writes relay.json mode 0600, and prints the URL to paste', async () => {
    const printed: string[] = []
    vi.mocked(process.stdout.write).mockImplementation((chunk: unknown) => {
      printed.push(String(chunk))
      return true
    })

    const result = (await run('connect', { url })) as { mcp_url: string; daemon_restarted: boolean }

    expect(result.mcp_url).toBe(`${url}/mcp/first-secret`)
    // No daemon is running under this scratch home, so there was nothing to restart.
    expect(result.daemon_restarted).toBe(false)
    expect(config()).toEqual({
      url,
      token: 'token-1',
      mcp_path: '/mcp/first-secret',
      allow_writes: false,
    })
    expect(statSync(configFile()).mode & 0o777).toBe(0o600)
    expect(printed.join('')).toContain(`${url}/mcp/first-secret`)
    expect(printed.join('')).toContain('read tools only')
  })

  it('sends a bearer token to the relay but never stores its value', async () => {
    await run('connect', { url }, { bearer: 's3cret-bearer' })

    expect(bearerSeen).toBe('s3cret-bearer')
    expect(config().bearer).toBe(true)
    expect(readFileSync(configFile(), 'utf8')).not.toContain('s3cret-bearer')
  })

  it('opts writes in and keeps them across a rotate, which replaces both secrets', async () => {
    await run('connect', { url }, { allowWrites: true })
    expect(config().allow_writes).toBe(true)

    await run('connect', {}, { rotate: true })

    const rotated = requests.at(-1)!
    expect(rotated).toMatchObject({ method: 'POST', path: '/rotate', token: 'token-1' })
    expect(config()).toMatchObject({ url, token: 'token-2', mcp_path: '/mcp/second-secret', allow_writes: true })
  })

  it('refuses to rotate a pairing that does not exist', async () => {
    await run('disconnect')
    await expect(run('connect', {}, { rotate: true })).rejects.toThrow(/NOT_CONNECTED/)
  })

  it('needs a URL from somewhere', async () => {
    await expect(run('connect')).rejects.toThrow(/NO_RELAY_URL/)
  })
})

describe('douze disconnect', () => {
  it('revokes the token at the relay and removes the local pairing', async () => {
    await run('connect', { url })
    expect(existsSync(configFile())).toBe(true)

    const result = (await run('disconnect')) as { revoked: boolean }

    expect(result.revoked).toBe(true)
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/register', token: 'token-1' })
    expect(existsSync(configFile())).toBe(false)
  })

  it('still removes the pairing when the relay cannot be reached', async () => {
    await run('connect', { url })
    const stopped = createServer()
    await new Promise<void>((resolve) => stopped.listen(0, '127.0.0.1', resolve))
    const deadPort = (stopped.address() as { port: number }).port
    await new Promise<void>((resolve) => stopped.close(() => resolve()))

    // Point the stored config at a port nothing listens on, the way a relay that went away looks.
    const current = config()
    const { writeRelayConfig } = await import('./remote-bridge.js')
    writeRelayConfig({ ...current, url: `http://127.0.0.1:${deadPort}` })

    const result = (await run('disconnect')) as { revoked: boolean }

    expect(result.revoked).toBe(false)
    expect(existsSync(configFile())).toBe(false)
  })
})
