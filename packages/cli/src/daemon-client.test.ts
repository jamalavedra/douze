import { createServer, type RequestListener, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeRuntime } from '@douze/douzed'
import { DaemonClient, DaemonHttpError, probe } from './daemon-client.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'douze-client-'))
  process.env['DOUZE_HOME'] = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env['DOUZE_HOME']
  delete process.env['DOUZE_RELAY_URL']
})

const listen = async (handler: RequestListener): Promise<{ server: Server; port: number }> => {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { server, port: (server.address() as { port: number }).port }
}

const stop = async (server: Server): Promise<void> => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

const json = (body: unknown, status = 200): RequestListener => {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}

/**
 * `wrangler dev` and RStudio Server both default to 8787, inside the range the daemon walks.
 * Adopting one meant sending it this install's token and then caching it as the endpoint for the
 * life of the process, because a fabricated pid made it look alive forever.
 */
describe('adopting a daemon over loopback (AC-RUN-003.3)', () => {
  it('refuses a listener that answers /health without being a douzed', async () => {
    const { server, port } = await listen(json({ status: 'ok' }))
    writeRuntime({ pid: process.pid, port, started_at: Date.now() })
    try {
      expect((await probe())?.port).not.toBe(port)
    } finally {
      await stop(server)
    }
  })

  it('adopts one whose /health names itself', async () => {
    const { server, port } = await listen(json({ ok: true, extension_connected: false }))
    writeRuntime({ pid: process.pid, port, started_at: Date.now() })
    try {
      expect((await probe())?.port).toBe(port)
    } finally {
      await stop(server)
    }
  })
})

/**
 * The endpoint was cached until a request threw at the network level, so a daemon that answered
 * but answered wrongly — restarted with a reissued token, or a port taken over — was never
 * re-resolved. `douze status` then failed identically until the process was restarted.
 */
describe('a cached endpoint that starts refusing (AC-RUN-003.4)', () => {
  it('re-resolves after an HTTP failure instead of holding the dead one', async () => {
    let servedByFirst = 0
    const first = await listen((_req, res) => {
      servedByFirst += 1
      // Healthy on the probe, but refusing the call — a reissued install token looks like this.
      if (servedByFirst === 1) return json({ ok: true, extension_connected: false })(_req, res)
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"invalid install token"}')
    })
    const second = await listen(json({ ok: true, extension_connected: true }))

    try {
      writeRuntime({ pid: process.pid, port: first.port, started_at: Date.now() })
      const client = new DaemonClient()
      await expect(client.health()).resolves.toMatchObject({ ok: true })
      await expect(client.health()).rejects.toBeInstanceOf(DaemonHttpError)

      // The daemon moved; the next call must find it rather than replay the cached endpoint.
      writeRuntime({ pid: process.pid, port: second.port, started_at: Date.now() })
      await expect(client.health()).resolves.toMatchObject({ extension_connected: true })
    } finally {
      await stop(first.server)
      await stop(second.server)
    }
  })
})
