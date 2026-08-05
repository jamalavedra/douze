import { startDaemon } from './server.js'

/**
 * AC-RUN-003.2 — a second recond exits non-zero with a message naming the running instance
 * rather than binding a second port.
 */
const daemon = await startDaemon().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})

process.stdout.write(`recond listening on http://127.0.0.1:${daemon.port}\n`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void daemon.close().then(() => process.exit(0))
  })
}
