import { startRelay } from './server.js'

// Loopback by default: this speaks plain HTTP and expects a terminator (a Cloudflare tunnel, a
// reverse proxy) on the same host to own the certificate. Set RELAY_HOST=0.0.0.0 only when the
// port is reachable by nothing but that terminator.
const host = process.env['RELAY_HOST'] ?? '127.0.0.1'
// Only safe when that proxy is the sole route to this port; see `trustProxy` in server.ts.
const trustProxy = process.env['TRUST_PROXY'] === '1'
const relay = await startRelay({
  port: Number(process.env['RELAY_PORT'] ?? 9787),
  host,
  trustProxy,
}).catch((error: Error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})

process.stdout.write(`douze relay listening on http://${host}:${relay.port}\n`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0))
  })
}
