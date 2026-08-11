import { startBridge } from './bridge.js'

/**
 * `npx @douze/bridge`, or whatever an MCP client is configured to spawn.
 *
 * Nothing here writes to stdout: that stream is the client's JSON-RPC session and a banner on it
 * is a corrupted handshake. Every message a human is meant to read — the pairing code included —
 * goes to stderr, which every MCP client captures into a log.
 */
const bridge = await startBridge({ input: process.stdin, output: process.stdout }).catch((error: Error) => {
  process.stderr.write(`douze-bridge: ${error.message}\n`)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void bridge.close().then(() => process.exit(0))
  })
}

// The client closing its end is the normal way this process ends; without it the listening socket
// would keep a bridge alive after the client that spawned it is gone.
process.stdin.on('end', () => {
  void bridge.close().then(() => process.exit(0))
})
