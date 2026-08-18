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

### Endpoint lifetime

Two clocks, both measured from the last time the **extension** attached. A platform client polling
`/m/<secret>` cannot move either of them; that is the point of measuring attachment rather than
traffic.

| Clock | Default | Effect |
|---|---|---|
| `ENDPOINT_ATTACH_WINDOWS` | 6 idle windows, 1 hour | Dormant: tool surface dropped, sessions closed, hashes kept. The URL still resolves. |
| `ENDPOINT_MAX_AGE_MS` | 30 days | Reaped: the endpoint and its `secretHash` are deleted. The URL 404s. |

Dormancy exists so the surface — tool names, descriptions and schemas, all derived from the user's
own dashboards — does not outlive the browser it came from, while the URL a user pasted into a
hosted connector by hand keeps working. The extension re-attaches to the same endpoint and
re-pushes its surface, which reaches connected clients as `notifications/tools/list_changed`.
While a surface is empty, `initialize` carries instructions naming the cause — extension away, or
nothing recorded yet — so a client with no tools to list can still tell its user what to do.

The 30-day clock bounds a disclosed URL. The URL is the whole credential unless the endpoint was
registered with a bearer token, and the extension does not send one, so without an outer clock a
copied URL would stay live forever and silently re-arm whenever the user's browser returned. It
also collects rows that `POST /register` plus a single `hello` would otherwise leave in the
registry permanently.

Besides those clocks, a link is removed by `DELETE /register` and by `POST /rotate`. A registration
no extension ever dialled is deleted after two idle windows, or six if a client keeps polling it.

**Restarts reset the 30-day clock.** Restored rows carry no timestamp — the file holds hashes and
nothing else — so a relay that is redeployed more often than monthly never reaps an abandoned
endpoint. Dormancy is unaffected. If accumulated dead rows ever matter, stopping the service and
removing `endpoints.json` invalidates every link, including live ones.

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

## Run it locally

```sh
pnpm --filter @douze/relay build
node packages/relay/dist/index.js
```

The build emits a self-contained `dist/index.js` requiring Node 22 or newer. Check it from another
terminal with `curl --fail http://127.0.0.1:9787/health`; the response is `{"ok":true}`.

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

## Production setup: systemd and Caddy

This is the recommended small deployment: one relay process, bound only to loopback, with Caddy
owning the public ports and TLS certificate.

```text
internet -- HTTPS/WSS --> Caddy -- HTTP/WS on 127.0.0.1:9787 --> Douze relay
```

Do not run multiple relay instances behind a load balancer. Sessions, tool surfaces, and in-flight
calls live in one process; `RELAY_STATE` persists endpoint hashes across restarts but is not a
shared database.

### 1. Prepare the host and DNS

Use a Linux host with Node 22 or newer, Corepack, Git, and Caddy. Point an `A`/`AAAA` record such as
`relay.example.com` at the host. Allow inbound TCP 80 and 443. Do not expose port 9787.

Clone and build the pinned release you intend to run:

```sh
sudo git clone https://github.com/jamalavedra/douze.git /opt/douze
sudo chown -R "$USER" /opt/douze
cd /opt/douze
git checkout main # use a reviewed release tag once one is published
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @douze/relay build
```

`packages/relay/dist/index.js` is the runtime entry point; source TypeScript and installed packages
are not loaded while the service is running.

### 2. Run the relay as a service

First run `command -v node`. If it does not print `/usr/bin/node`, use the printed absolute path in
`ExecStart` below.

Create `/etc/systemd/system/douze-relay.service`:

```ini
[Unit]
Description=Douze relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=/opt/douze
ExecStart=/usr/bin/node /opt/douze/packages/relay/dist/index.js
Environment=RELAY_HOST=127.0.0.1
Environment=RELAY_PORT=9787
Environment=TRUST_PROXY=1
StateDirectory=douze-relay
UMask=0077
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

`StateDirectory` creates `/var/lib/douze-relay` and lets the otherwise temporary service user write
only there. Endpoint token, URL-secret, and optional bearer hashes survive a restart; tool names,
schemas, calls, and results do not go to disk.

Start it and inspect the first log lines:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now douze-relay
sudo systemctl status douze-relay
sudo journalctl -u douze-relay -n 50 --no-pager
curl --fail http://127.0.0.1:9787/health
```

### 3. Put Caddy in front

Add this site to `/etc/caddy/Caddyfile`, replacing the hostname:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:9787
}
```

Caddy obtains and renews the certificate and proxies WebSocket upgrades without extra directives.
Validate and reload it:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://relay.example.com/health
```

The public health response must again be `{"ok":true}`. A certificate error, redirect to another
hostname, or non-200 response must be fixed before connecting Douze.

`TRUST_PROXY=1` is correct in this layout because only Caddy can reach the loopback relay port. It
lets registration rate limits use the real caller address. Do not enable it when callers can reach
the relay directly, because they could forge forwarded-address headers.

### 4. Connect the extension

Open Douze's **Use Douze with your AI** page, expand **Use a different relay**, and enter only the
origin, for example `https://relay.example.com`—no `/register`, `/ws`, or trailing MCP path. Click
**Connect**. Douze registers an endpoint, stores its private registration token in extension
storage, and shows the MCP URL to paste into the hosted assistant.

The MCP URL is a credential. Anyone holding it can use the tools that the extension exposes. Rotate
the link from the same page if it is copied to the wrong place; stop sharing to delete the endpoint.

## Operations

### Upgrade

Build a reviewed tag before restarting. With `StateDirectory` configured, existing MCP URLs remain
valid and the extension republishes its in-memory tool surface after reconnecting.

```sh
cd /opt/douze
git fetch --tags
git checkout <release-tag>
pnpm install --frozen-lockfile
pnpm --filter @douze/relay build
sudo systemctl restart douze-relay
curl --fail https://relay.example.com/health
```

### Logs and recovery

Use `journalctl -u douze-relay` for event logs. They contain counters and short endpoint hash
prefixes, not tool arguments or results. Back up `/var/lib/douze-relay/endpoints.json` if preserving
existing links matters. Losing or replacing that file invalidates every registered MCP URL; users
must connect again and paste the new links into their assistants.

If health is down, check the relay service first, then Caddy and DNS. If health is up but an MCP URL
is offline, open the browser containing Douze: the relay cannot execute a tool until that extension
reconnects, and a call waits out the 40-second wake window for it. A briefly closed browser costs
nothing — sessions and the cached tool list survive for an hour, after which the endpoint is
dormant and `tools/list` answers empty until the extension dials in again (see Endpoint lifetime).
The URL stays valid throughout, so a user reporting "my assistant has no tools" needs their browser
open, not a new link.

### Security checklist

- Keep the relay on `127.0.0.1`; expose only the TLS proxy on ports 80/443.
- Keep Node and the checked-out Douze release updated.
- Restrict access to the host, journal, Caddy configuration, and relay state file.
- Monitor registration refusals and unexpected request volume in the journal.
- Treat every MCP URL as a password and rotate it after accidental disclosure. A disclosed URL is a
  live capability until it is rotated: dormancy empties the tool list but does not invalidate the
  URL, and the endpoint is deleted on its own only after 30 days with no extension attachment.
- Remember that the relay operator can read or alter live tool arguments and results even though
  the relay does not persist or log them.
