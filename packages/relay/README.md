# @douze/relay

The relay that lets hosted MCP clients — ChatGPT, claude.ai web and mobile, Dust, anything
speaking streamable HTTP — reach a Douze daemon running on someone's laptop. The daemon dials
out over one WebSocket and opens no listener; the relay hands each platform client a per-user
URL and forwards JSON-RPC messages between the two. It is stateless: every endpoint and session
lives in memory and dies with the process, nothing is written to disk, and no payload is logged.

## Trust model

The relay operator can read and inject every MCP message that crosses it — tool arguments and
full result bodies, which are live dashboard data. That is a property of the design, not a bug to
be patched: the only remedy is running your own, which is what `DOUZE_REMOTE_URL` is for.

Secrets are stored as sha256 hashes, so the running process holds nothing that would let anyone
impersonate a daemon or reach a user's tools; the URL secret is a ≥32-byte base64url random that
must never leave TLS, and the logs carry timestamps, event names, durations, and an 8-character
hash prefix per endpoint — never a payload, a tool name, a session id, or a secret.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /register` | none, 10/hour per caller | `{daemon_version, bearer_token?}` → `201 {token, mcp_path}` |
| `POST /rotate` | `x-douze-relay-token` | new token and path; the old pair dies immediately |
| `DELETE /register` | `x-douze-relay-token` | drops the endpoint, closes the socket, expires sessions |
| `GET /health` | none | `{ok: true}` |
| `WS /ws` | first frame `hello{token}`, within 5s | the daemon's one connection |
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
still in flight is a 409. `GET /m/<secret>` is 405 — there is no server-initiated stream in v1,
so clients see tool changes when they next poll `tools/list`.

A refusal that a hosted client would otherwise swallow — offline, timeout, in flight, duplicate
id — comes back as `200 {"jsonrpc":"2.0","id":…,"error":{"code":-32000,"message":…}}`, because an
MCP client renders a JSON-RPC error and drops an HTTP error body. `initialize`, notifications, and
401/404/413 keep their HTTP status, which is what makes a client re-authenticate or re-initialize.

When the daemon socket drops, in-flight requests fail immediately with `502 daemon_offline`
rather than waiting out their timeout, and the endpoint's sessions are gone with it.

## Deploying

`pnpm --filter @douze/relay build` emits one file, `dist/index.js`, with `ws` and the shared
schemas bundled in. A deploy is that file plus a Node 22 host — no install step, no
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

On the daemon side, point Douze at your instance with `DOUZE_REMOTE_URL`.
