# @douze/relay

The relay that lets hosted MCP clients — ChatGPT, claude.ai web and mobile, Dust, anything
speaking streamable HTTP — reach the Douze extension running in someone's browser. The extension
dials out over one WebSocket and opens no listener; the relay hands each platform client a
per-user URL and answers its MCP session itself.

It **terminates MCP** rather than forwarding it. One `McpHost` (`@douze/mcp-host`) per session
answers `initialize` and `tools/list` here, from the surface the extension last pushed, and only a
`tools/call` is sent on to the browser. That is not an optimisation: the attached party is an MV3
service worker Chrome evicts at will, it can hold no session state, and no inbound frame wakes it.
Terminating here is what lets a connector added while the browser was closed list its tools
instead of looking broken.

Still stateless in the sense that matters: every endpoint lives in memory and dies with the
process, nothing is written to disk, and no payload is logged.

## Trust model

The relay operator can read and inject every MCP message that crosses it — tool arguments and
full result bodies, which are live dashboard data. That is a property of the design, not a bug to
be patched: the only remedy is running your own, which is what `DOUZE_REMOTE_URL` is for.

**The relay also holds each endpoint's tool surface in memory** — every tool name, description and
input schema the extension has pushed — because that is what `tools/list` is answered from. This
is new, and it is more than the transport used to see: the names and descriptions of your recipes
describe the systems you have automated, whether or not anyone ever calls them. They are held for
as long as the endpoint lives, never written to disk, and never logged; the log records a count.

Secrets are stored as sha256 hashes, so the running process holds nothing that would let anyone
impersonate an extension or reach a user's tools; the URL secret is a ≥32-byte base64url random
that must never leave TLS, and the logs carry timestamps, event names, durations, counts, and an
8-character hash prefix per endpoint — never a payload, a tool name, a description, a session id,
or a secret.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /register` | none, 10/hour per caller | `{daemon_version, bearer_token?}` → `201 {token, mcp_path}` |
| `POST /rotate` | `x-douze-relay-token` | new token and path; the old pair dies immediately |
| `DELETE /register` | `x-douze-relay-token` | drops the endpoint, closes the socket, closes its sessions |
| `GET /health` | none | `{ok: true}` |
| `WS /ws` | first frame `hello{token}`, within 5s | the extension's one connection |
| `POST /m/<secret>` | the secret, plus `Authorization: Bearer` if one was registered | the MCP endpoint |
| `DELETE /m/<secret>` | same | closes the session named by `Mcp-Session-Id` |

The registration limit counts per socket address, which behind the TLS terminator below is the
terminator itself — one bucket for every user of the deployment, which the first of the hour
exhausts for everyone. `TRUST_PROXY=1` charges it to `cf-connecting-ip`/`x-forwarded-for`
instead. Set it only where that proxy is the sole route to the port, because anywhere else a
caller forges the header and buys a fresh bucket per request.

`initialize` mints a session and returns it in `Mcp-Session-Id`; every later request must carry
that header, and an unknown one gets a 404 so the client re-initializes. Requests cap at 1 MB,
8 in flight per endpoint, 4 sessions per endpoint, and 120s each; reusing a JSON-RPC id that is
still in flight is a 409. `GET /m/<secret>` is 405 — there is no server-initiated stream in v1, so
a client sees a tool change when it next polls `tools/list`.

A refusal that a hosted client would otherwise swallow — in flight, duplicate id, too many
sessions — comes back as `200 {"jsonrpc":"2.0","id":…,"error":{"code":-32000,"message":…}}`,
because an MCP client renders a JSON-RPC error and drops an HTTP error body. `initialize`,
notifications, and 401/404/413 keep their HTTP status, which is what makes a client
re-authenticate or re-initialize. Anything the extension itself fails is already a JSON-RPC error
carrying `data.error` (a `RelayErrorCode`) and `data.retryable`.

## The attachment socket

`WS /ws` speaks the attachment protocol from `@douze/mcp-host`, the same one the local stdio
bridge speaks, so the extension has a single implementation and does not care which is on the far
side. Extension → relay: `hello` (with the endpoint `token` alongside `extension_version`), `pong`,
`surface.push`, `tool.result`. Relay → extension: `welcome`, `ping`, `tool.call`.

One socket per endpoint — a second `hello` is a reconnecting worker and wins — and one cached
surface per endpoint, replaced wholesale by each `surface.push` and fanned out to every live
session, including seeding a session created later.

Sessions survive the socket. When it drops, in-flight calls fail at once with a retryable
`extension_disconnected` rather than waiting out their timeout, and **none of them is ever
re-sent**: a tool can be a write, and a silent retry of a write is worse than a failure a human
decides about. `initialize` and `tools/list` keep working from cache the whole time.

### The wake grace

A `tools/call` that arrives with no live socket is held for **40 seconds** before it is answered
as offline. An evicted service worker cannot be woken from outside, and the only thing that
revives it on its own is `chrome.alarms`, whose minimum period is 30 seconds — so a shorter grace
would report a browser that is merely asleep as one that is gone. The call is sent once the
extension re-attaches, or refused when the grace runs out. `initialize` and `tools/list` never
wait.

## Deploying

`pnpm --filter @douze/relay build` emits one file, `dist/index.js`, with `ws`, the host, and the
shared schemas bundled in. A deploy is that file plus a Node 22 host — no install step, no
`node_modules` to keep in sync. Nothing to provision either: no database, no volume, no shared
state, so a restart costs a reconnect and nothing else.

Terminate TLS in front of it (a Cloudflare tunnel, Fly, a reverse proxy). The process binds
loopback and speaks plain HTTP, so the terminator must reach it over localhost; widening
`RELAY_HOST` puts an unencrypted relay on a public interface, which is what the trust model
above assumes never happens.

| Env var | Default | Meaning |
| --- | --- | --- |
| `RELAY_PORT` | `9787` | the port to bind |
| `RELAY_HOST` | `127.0.0.1` | the interface to bind; widen only with nothing terminating TLS in front |
| `TRUST_PROXY` | unset | charge rate limits to the forwarded caller (see above) |

A systemd unit is enough to run it; the one deployment so far is a user unit with
`Restart=always` behind a Cloudflare tunnel pointed at `http://127.0.0.1:9787`.

On the extension side, point Douze at your instance with `DOUZE_REMOTE_URL`.
