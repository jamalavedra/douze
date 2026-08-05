import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createApi, type StudioSession } from './api.js'

export interface StudioServer {
  port: number
  url: string
  close: () => Promise<void>
}

/**
 * T-007.1 — the review UI on loopback only. Studio is dev-time and short-lived (ADR-006), so it
 * carries no install token: it binds 127.0.0.1 and is quit when the recipe is done.
 */
export async function startStudio(session: StudioSession, options: { port?: number } = {}): Promise<StudioServer> {
  const app = createApi(session)

  const server = createServer(async (req, res) => {
    const response = await app.fetch(
      new Request(`http://127.0.0.1${req.url ?? '/'}`, {
        method: req.method,
        headers: req.headers as HeadersInit,
        ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: await readBody(req), duplex: 'half' }),
      } as RequestInit),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })

  const port = await listen(server, options.port ?? Number(process.env['RECON_STUDIO_PORT'] ?? 0))
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
