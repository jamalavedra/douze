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
| `POST /register` | none, 10/hour per IP | `{daemon_version, bearer_token?}` → `201 {token, mcp_path}` |
| `POST /rotate` | `x-douze-relay-token` | new token and path; the old pair dies immediately |
| `DELETE /register` | `x-douze-relay-token` | drops the endpoint, closes the socket, expires sessions |
| `GET /health` | none | `{ok: true}` |
| `WS /ws` | first frame `hello{token}`, within 5s | the daemon's one connection |
| `POST /m/<secret>` | the secret, plus `Authorization: Bearer` if one was registered | the MCP endpoint |
| `DELETE /m/<secret>` | same | closes the session named by `Mcp-Session-Id` |

`initialize` mints a session and returns it in `Mcp-Session-Id`; every later request must carry
that header, and an unknown one gets a 404 so the client re-initializes. Requests cap at 1 MB,
8 in flight per endpoint, and 120s each. `GET /m/<secret>` is 405 — there is no server-initiated
stream in v1, so clients see tool changes when they next poll `tools/list`.

When the daemon socket drops, in-flight requests fail immediately with `502 daemon_offline`
rather than waiting out their timeout, and the endpoint's sessions are gone with it.

## Deploying

Any Node 22 host: `pnpm build && node dist/bin.js`. Nothing to provision — no database, no
volume, no shared state, so a restart costs a reconnect and nothing else. Terminate TLS in front
of it (Fly, Render, a reverse proxy); the process binds plain HTTP on `0.0.0.0` and assumes
anything reaching that port is already inside the terminator.

| Env var | Default | Meaning |
| --- | --- | --- |
| `RELAY_PORT` | `9787` | the port to bind |

On the daemon side, point Douze at your instance with `DOUZE_REMOTE_URL`.
