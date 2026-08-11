import { startRelay } from './server.js'

// TLS is the deployment platform's job: this binds plain HTTP on 0.0.0.0 and expects to sit
// behind a terminator that owns the certificate. Never expose this port to the internet directly.
const relay = await startRelay({ port: Number(process.env['RELAY_PORT'] ?? 9787) }).catch((error: Error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})

process.stdout.write(`douze relay listening on http://0.0.0.0:${relay.port}\n`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0))
  })
}
