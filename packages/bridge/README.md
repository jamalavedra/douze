# @douze/bridge

The optional local transport between a stdio MCP client and the Douze extension.

```text
MCP client ── newline-delimited JSON-RPC/stdin+stdout ── bridge
bridge     ◀── ws://127.0.0.1:8912-8916 ── extension
```

The bridge terminates MCP through `@douze/mcp-host`. It stores no recipes, captures, fixtures, or
policy. Stdout carries JSON-RPC only; diagnostics and the first pairing code go to stderr.

## Build and configure

```sh
pnpm --filter @douze/bridge build
```

The build emits a self-contained Node 22 executable at `packages/bridge/dist/index.js`. The package
is private and is not available through `npx`.

Configure a local MCP client to start that file:

```jsonc
{
  "mcpServers": {
    "douze": {
      "command": "node",
      "args": ["/absolute/path/to/douze/packages/bridge/dist/index.js"]
    }
  }
}
```

On first run, stderr shows the listener and a code:

```text
douze-bridge: listening on ws://127.0.0.1:8912/ws
douze-bridge:   Pairing code: 7Q78-PEXT
```

Enter the code on the extension's connect page. Later bridge processes use the credential in
`~/.douze/bridge.json` and print no code.

## Local trust

The extension derives trust from the authenticated attachment, not from a field supplied by the
MCP client.

| Capability | Relay | Paired bridge |
|---|---|---|
| Read | Always | Always |
| Write | Opt-in per relay attachment | Always |
| Destructive | Never | Requires `confirm: true` |
| Result secret gate | Enforced; per-tool exemption | Enforced; separate per-tool exemption |

Loopback is not authentication: any local process can bind an unused port. The extension grants
local trust only after both sides prove possession of the pairing credential.

## Pairing protocol

Both ends use `packages/shared/src/bridge-handshake.ts`:

```text
extension → hello             { extension_version, nonce: Ne }
bridge    → bridge.challenge  { nonce: Nb, salt?, proof: P(bridge) }
extension → bridge.proof      { proof: P(extension) }
bridge    → welcome           { heartbeat_ms, secret? }
```

```text
P(role) = HMAC-SHA256(K, "douze-bridge-v1|<role>|<port>|<Ne>|<Nb>|<salt>")
```

For first pairing, `K` is PBKDF2-SHA256 over the eight-character code, a per-process 32-byte salt,
and 600,000 rounds. The code is single-use and expires after ten minutes. Ten incorrect proofs
disable pairing until the bridge restarts. The bridge accepts WebSocket upgrades only from a
`chrome-extension://` origin.

After pairing, the bridge generates a 32-byte secret. The extension stores that secret; the bridge
stores only its SHA-256 digest in `~/.douze/bridge.json`, mode `0600`. Subsequent attachments use the
digest as their HMAC key. Fresh nonces prevent replay, roles prevent reflection, and the port binds
the proof to one listener.

The pairing code has about 39 bits of entropy. A captured first-pairing challenge is an offline
guessing oracle; the PBKDF2 cost, per-process salt, and ten-minute expiry reduce that risk. The
online ten-attempt limit does not prevent offline guesses.

Pairing does not defend against malware running as the same OS user. Such a process can read the
bridge credential file or browser profile and impersonate an endpoint. File mode `0600` protects
against other users, not other processes owned by the same user.

Delete `~/.douze/bridge.json` and restart the client to pair again after reinstalling or resetting
the extension.

## Ports and lifecycle

Each client starts its own bridge. Bridges bind the first available port in `8912-8916`, and the
extension scans the same range.

- A second authenticated extension socket replaces the first.
- Socket loss fails in-flight calls immediately; calls are never retried.
- `surface.push` updates the cached tools and emits `notifications/tools/list_changed` on stdout.
- The host sends `ping` every 20 seconds and terminates after two missed windows.
- Each handshake phase has a five-second deadline.
- A call received before the extension attaches waits up to 40 seconds; `initialize` and
  `tools/list` use the cached surface immediately.
