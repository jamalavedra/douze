# @douze/relay

The hosted transport between remote MCP clients and the Douze extension.

The extension opens an outbound WebSocket to the relay. The relay terminates streamable HTTP MCP,
answers `initialize` and `tools/list` from its cached surface, and forwards only `tools/call` to the
browser.

## Trust and state

The relay operator can read and inject every MCP message, including tool arguments and full result
bodies. Run the relay yourself if that trust is unacceptable.

In memory, each endpoint holds:

- the latest tool names, descriptions, and input schemas pushed by the extension;
- MCP sessions and in-flight calls;
- hashes of the extension token, MCP URL secret, and optional bearer token.

Payloads, tool definitions, session IDs, and secrets are not logged. Logs contain timestamps,
event names, durations, counts, status/refusal codes, and an eight-character endpoint hash prefix.

By default nothing is persisted and a restart invalidates every link. When `RELAY_STATE` is set,
the relay atomically writes `endpoints.json` in that directory with three hashes per endpoint:
`tokenHash`, `secretHash`, and `bearerHash`. Tool surfaces and payloads remain memory-only.

Endpoints with no extension attachment expire after six idle windows (one hour by default).
Never-used registrations expire after two windows.

## HTTP API

| Route | Authentication | Purpose |
|---|---|---|
| `POST /register` | None; 10/hour per caller | `{daemon_version, bearer_token?}` → `201 {token, mcp_path}` |
| `POST /rotate` | `x-douze-relay-token` | Replace the endpoint token and MCP path |
| `DELETE /register` | `x-douze-relay-token` | Remove the endpoint and close its sessions |
| `GET /health` | None | Return `{ok: true}` |
| `WS /ws` | First `hello{token}` frame within 5 seconds | Attach the extension |
| `POST /m/<secret>` | URL secret; optional bearer | MCP request endpoint |
| `GET /m/<secret>` | URL secret, optional bearer, and `Mcp-Session-Id` | SSE notifications for the session |
| `DELETE /m/<secret>` | Same as POST | Close the named session |

`daemon_version` remains the registration field for protocol compatibility. A registration body
without it receives `404 not_found`, preventing OAuth dynamic-client probes from creating Douze
endpoints.

`initialize` returns `Mcp-Session-Id`; later requests must provide it. Sessions expire after 10
minutes idle or 12 hours total. Per endpoint, the relay permits eight sessions and eight in-flight
requests. Request bodies are limited to 1 MiB and calls to 120 seconds. At the session limit, the
least-recently-used session is retired.

Set `TRUST_PROXY=1` only when a trusted proxy is the sole route to the relay port. Otherwise callers
can forge forwarded addresses and bypass registration rate limits.

## Attachment protocol

`WS /ws` uses the attachment protocol from `@douze/mcp-host`:

```text
extension → hello, pong, surface.push, tool.result
relay     → welcome, ping, tool.call
```

One socket is active per endpoint; a new authenticated socket replaces the previous one. Socket
loss fails in-flight calls immediately and calls are never retried because they may be writes.
Cached `initialize` and `tools/list` responses remain available.

A call received without a live extension waits up to 40 seconds for the extension's 30-second
`chrome.alarms` reconnect. It is forwarded once after reconnection or returned as offline.

## Build and run

```sh
pnpm --filter @douze/relay build
node packages/relay/dist/index.js
```

The build emits a self-contained `dist/index.js` requiring Node 22 or newer.

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_PORT` | `9787` | Listen port |
| `RELAY_HOST` | `127.0.0.1` | Listen address |
| `TRUST_PROXY` | unset | Trust `cf-connecting-ip`/`x-forwarded-for` for rate limits when set to `1` |
| `RELAY_STATE` | unset | Writable directory for `endpoints.json` |

The process serves plain HTTP. Terminate TLS with a tunnel or reverse proxy. Keep the default
loopback binding when the terminator runs on the same host. Set `RELAY_HOST=0.0.0.0` only when the
port is reachable exclusively through a trusted TLS terminator.

Under systemd, `StateDirectory=douze-relay` supplies `STATE_DIRECTORY`; the binary uses it when
`RELAY_STATE` is unset.
