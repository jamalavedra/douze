# Douze intern verification flow

Use this guide to verify Douze without touching a real account first. It covers the complete
capture-to-call path, the two authentication boundaries, the local HTTP/WebSocket API, and the
remaining live-verification work.

## Pass criteria

An intern can mark the application verified only when all of these are true:

- Build, typecheck, unit tests, and the focused browser tests pass.
- Cookie and page-state authentication both reach the fixture API.
- No cookie, bearer token, CSRF value, password, or API key reaches persisted artifacts.
- Missing confirmation, a degraded tool, a disconnected extension, and an expired target session
  fail before an unsafe retry or unintended target request.
- A recorded read tool appears through the daemon API, CLI, and MCP surface and returns live data.
- A second approved recipe appears in a running MCP session without reinstalling or reconnecting.
- The read-only Openfort run passes. The write run is optional and requires explicit approval.

## System flow

```mermaid
sequenceDiagram
    actor User
    participant Page as Signed-in dashboard
    participant Ext as Chrome extension
    participant D as douzed on 127.0.0.1
    participant Studio as Review/inference
    participant Client as CLI or MCP client
    participant API as Dashboard API

    User->>Ext: Watch this site
    Ext->>Page: Reload with capture interceptor
    User->>Page: Perform normal workflow
    Page->>API: Authenticated fetch/XHR
    Ext->>Ext: Redact headers, URL, and bodies
    Ext->>D: exchange.append over authenticated WebSocket
    User->>Ext: Done
    Ext->>Studio: Open local review page
    Studio->>D: Approve and save recipe + fixtures
    D-->>Client: Hot-reload approved tools
    Client->>D: POST /relay/:recipe/:tool
    D->>Ext: relay.request
    Ext->>Page: Read current page-state credential if declared
    Ext->>API: fetch from browser context; credentials included when required
    API-->>Ext: JSON response
    Ext-->>D: relay.response
    D-->>Client: Redacted, shaped result
```

## 1. Prepare an isolated run

Prerequisites are Node 22+, pnpm, and Helium at
`/Applications/Helium.app/Contents/MacOS/Helium`. Browser tests are macOS-only in the current
harness and run headed with one worker.

Do not point verification at `~/.douze`. The automated harness creates scratch `DOUZE_HOME`
directories and disposable browser profiles. The live script instead defaults to `~/.douze-live`
and a persistent `~/.douze-e2e-profile` because a real login must survive restarts.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

Expected result: every command exits zero. Do not update dependencies to make this pass; record
the failing command and first relevant error. One negative eject test intentionally prints
`1 of 4 fixture replays failed: get_order`; use Vitest's final pass/fail summary and process exit
code, not that expected fixture-corruption message.

## 2. Verify authentication and API execution against the fixture

Run the smallest browser set that proves the security and execution model:

```sh
lsof -nP -iTCP:4180 -sTCP:LISTEN
```

This preflight must print nothing. If another fixture or developer process owns port 4180, ask its
owner to stop it before continuing; the harness deliberately refuses to reuse an existing server.

```sh
pnpm verify:e2e
```

This runs the whole-app journey plus the narrower cookie/page-state authentication and preflight
guard cases: local API authentication, dashboard login, capture, redaction, review UI approval,
recipe hot reload, browser relay, MCP listing/call, target-session expiry with no retry,
destructive confirmation, and degraded-tool refusal.

Playwright's global setup builds the extension with `http://127.0.0.1:4180` granted. It launches
Helium, the fixture API, and scratch daemon instances automatically.

Record this evidence:

| Check | Required evidence |
|---|---|
| Capture | POST and GET request/response bodies are persisted; CSS and analytics are absent. |
| Redaction | `authorization` and `password` are placeholders and originals are absent on disk. |
| Cookie auth | The fixture server receives `fixture_session` on a relayed GET. |
| Page-state auth | The fixture receives current bearer and CSRF values read from page state. |
| Expiry | A target 401 becomes `session_expired`; exactly one target request was made. |
| Guards | Missing `confirm`, degraded tools, and unknown tools produce zero target requests. |
| Surface | Only approved tools are namespaced as `<recipe>_<tool>`. |
| Connector | MCP initializes, lists tools, and forwards a call through the same relay. |

Then run the complete browser suite:

```sh
pnpm e2e
```

## 3. Manually verify the product flow

Use a scratch Chrome/Helium profile and the local fixture, not a personal browser profile.

1. Build the extension: `pnpm --filter @douze/extension build`.
2. Start the fixture: `pnpm exec tsx fixtures/server.ts`.
3. Start Douze: `pnpm exec tsx packages/cli/src/bin.ts start`.
4. Load `packages/extension/dist` as an unpacked extension.
5. Open `http://127.0.0.1:4180` and POST `/login` through the page or use the browser test to
   establish the fixture cookie.
6. Click **Watch this site**, use **Create order** and **List orders**, add a note, then click
   **Done**.
7. Confirm the review page lists inferred candidates. Bulk-enable reads only. Inspect write and
   destructive candidates individually.
8. Save, run `pnpm exec tsx packages/cli/src/bin.ts status`, and confirm the extension is
   connected and the tool count is non-zero.
9. Invoke the approved read through `douze <recipe> <tool>` or an MCP client.
10. Confirm the fixture's `/__test/log` shows one authenticated target request.

Do not approve or call a destructive tool merely to complete this checklist. Its preflight guard
is already verified by `e2e/relay/guards.spec.ts`.

## 4. Live read-only verification

This is the outstanding release criterion tracked as C-1 in `TASKS.md`:

```sh
pnpm exec tsx e2e/live/openfort.mjs
```

On the first run, sign in manually in the Helium window. The script then:

1. builds the extension with dashboard and API origins granted;
2. starts a daemon under `DOUZE_HOME` (default `~/.douze-live`);
3. records real authenticated dashboard traffic;
4. scans the persisted capture for JWT and prefixed-key leaks;
5. infers and approves read candidates;
6. confirms registry hot reload;
7. calls one read through the browser relay; and
8. verifies the same tools through an MCP `tools/list` exchange.

If Openfort uses additional API hosts, set a comma-separated `DOUZE_LIVE_API_ORIGINS`. Never put
credentials in this variable; it accepts origins only.

`pnpm exec tsx e2e/live/openfort.mjs --writes` approves and invokes write tools. Run it only with an account
whose data may be changed and explicit owner approval. It is not required for the read-only gate.

For C-2, keep the MCP session running, record and approve a second target, and require a
`notifications/tools/list_changed` notification followed by both recipes in `tools/list`. No MCP
restart or connector reinstall is allowed.

## Authentication inventory

### A. Target-site authentication

This is authentication to the dashboard/API being automated. Douze does not implement login and
does not store the primary-path credential.

| Mode | How it works | What is persisted | Required verification |
|---|---|---|---|
| Cookie browser relay | The extension executes `fetch` in a tab on the execution origin with `credentials: include`; Chrome attaches cookies, including HttpOnly cookies. | Recipe descriptor `{kind: cookie}` only. | Fixture server receives the cookie; persisted files do not. |
| Page-state browser relay | Capture discovers the storage expression that produced a header or credential-shaped path segment. At call time the extension reads the current value in the page's MAIN world, then attaches it in the isolated-world request. | Expression, destination header/parameter, and prefix only; never the value. | Bearer and CSRF fixture case succeeds; registry and disk contain neither value. |
| Cross-origin API | The recipe stores `page_origin` for the dashboard and `target.base_url` for the API. Execution occurs from the dashboard tab so storage and CORS origin match. Token-only cross-origin requests use `credentials: omit`; cookie requests use `include`. | Origins and credential locations only. | Live target retains API-host exchanges and relay succeeds. |
| Headless, degraded | `executeHeadless` reads a session from the macOS Keychain, may refresh once after 401, and labels the result degraded. It is never an implicit fallback. | `keychain_ref` and optional refresh endpoint; session is in Keychain. | Unit coverage exists in `packages/douzed/src/headless.test.ts`. See the known gap below before claiming product support. |

Session expiry is a target 401, 403, or redirect to a login/auth path. Browser relay performs no
retry and tells the user to sign in again. The extension can show a login notification. Headless
mode alone may refresh once when explicitly configured.

### B. Douze local-control authentication

This protects the local daemon and is separate from target-site authentication.

- `douzed` binds `127.0.0.1`, normally on 8787-8791.
- A 24-byte random base64url install token is created at `$DOUZE_HOME/token` with mode `0600`.
- Every HTTP route except `/health` and `/pair` requires `x-douze-token` or a `token` query
  parameter. The CLI adds the header automatically.
- `/pair` accepts only a syntactically valid `chrome-extension://<extension-id>` Origin, returns
  CORS only to that exact origin, and pins the first extension ID at `$DOUZE_HOME/extension`.
- The WebSocket requires the token in `/ws?token=...`; invalid upgrades close with code 1008.
- HTTP and WebSocket traffic also reject non-loopback `Host` headers to reduce DNS-rebinding risk.
- Review links carry the local token because their own API requests require it. A stale token gets
  a human-readable expired-link page.
- The MCP transport has its own JSON-RPC initialization but no separate Douze account. It calls
  the authenticated loopback API through `DaemonClient`.

Verify this boundary directly with:

```sh
pnpm --filter @douze/douzed test
pnpm --filter @douze/extension test
```

The tests must cover missing-token 401, pairing Origin validation, first-extension pinning,
second-extension refusal, loopback Host validation, WebSocket token use, and reconnection.

### C. Secret handling

Redaction happens before an exchange leaves the extension and again at daemon/store, fixture,
audit, recipe, eject, and model-description boundaries.

- Always-secret headers include authorization, cookie, set-cookie, API key, CSRF/XSRF, and proxy
  authorization variants.
- Secret-like body/query keys include password, token, secret, API key, refresh/access token,
  client secret, private key, session, and credential variants.
- JWTs, Basic/Bearer strings, prefixed keys, and long high-entropy values are detected by value
  shape even when the field name looks harmless.
- Stored placeholders preserve type and string length, for example `«redacted:string:28»`.
- A final `findSurvivingSecrets` gate refuses anything redaction missed.
- Audit arguments are redacted, and tool errors are recorded without retrying the target.

This guarantee covers Douze persistence and model-description input. A successful live tool call
returns the target API's response to the requesting CLI/MCP client; the relay does not redact that
result body. Verify read tools do not expose secrets as ordinary business data before approving
them.

Run the repository-wide artifact sweep after the browser suite:

```sh
pnpm exec tsx e2e/metrics.mjs
```

## Local HTTP API inventory

Base URL is the runtime's `http://127.0.0.1:<port>`. Unless noted, send JSON and
`x-douze-token: <install token>`.

| Method and path | Authentication | Purpose / body | Main response or failure |
|---|---|---|---|
| `GET /health` | None | Liveness and extension connection state. | `{ok, extension_connected}` |
| `GET, OPTIONS /pair` | Chrome-extension Origin; first ID is pinned | Give the extension its token and bound port. | `{token, port, version}` or 403 |
| `GET /registry` | Install token | Current hot-loaded tool surface and recipe errors. | `{revision, tools, errors}` |
| `GET /recipes` | Install token | Parsed recipes. | `Recipe[]` |
| `GET /sessions` | Install token | Capture-session summaries. | `CaptureSession[]` |
| `GET /sessions/:id` | Install token | Session, redacted exchanges, and annotations. | `{session, exchanges, annotations}` or 404 |
| `POST /doctor/:recipe` | Install token | Replay read fixtures and classify drift. | Doctor report or 400 `doctor_failed` |
| `POST /import/har` | Install token | `{har, name}`; filter/redact and create a session. | Imported session summary |
| `GET /review/:sessionId` | Install token in link | Serve the local review UI. | HTML; human-readable 401/404 pages |
| `GET /api/review/:sessionId` | Install token | Candidate list for the review page. | `{site, recipe, candidates}` or 404 |
| `POST /api/review/:sessionId/enable` | Install token | Empty body bulk-enables reads; `{names}` enables named candidates. | `{enabled, skipped}` |
| `POST /api/review/:sessionId/disable` | Install token | `{names}` unapproves candidates. | `{ok: true}` |
| `POST /api/review/:sessionId/edit` | Install token | `{name, field, value}` edits and immediately saves. | `{ok: true}` or 400 |
| `POST /api/review/:sessionId/save` | Install token | Write fixtures then validated recipe. | `{path, tools}` or 400 `save_failed` |
| `GET /api/site-tools?origin=...` | Install token; extension Origin gets matching CORS | Tools already approved for one site. | `{tools}` |
| `POST /relay/:recipe/:tool` | Install token | `{args, timeout_ms?}`; enforce guards and relay to browser. | `RelayResponse`; 404 unknown tool; 502 named Douze error |

The relay endpoint returns target `status`, response `headers`, parsed `body`, `duration_ms`, and
`redirected_to_login`. It can return these named errors: `relay_unreachable`,
`extension_disconnected`, `session_expired`, `tool_degraded`, `confirm_required`, `rate_limited`,
and `timeout`. Current rate limiting queues calls; it does not deliberately emit `rate_limited`.

## Fixture target API inventory

The fixture on `http://127.0.0.1:4180` stands in for a dashboard; it is not part of the shipped
daemon API. Its protected routes accept either the `fixture_session` cookie or the exact bearer
plus CSRF pair served by its page-state-auth variant.

| Method and path | Purpose |
|---|---|
| `POST /login` | Set the fixture session cookie. |
| `GET, POST /api/orders` | List or create orders. |
| `GET, DELETE /api/orders/:id` | Read or destructively delete one order. |
| `GET /api/report` | Return a large envelope with a small primary payload. |
| `GET /api/poll` | Generate background traffic. |
| `POST /graphql` | Exercise named query/mutation inference and GraphQL errors. |
| `GET /__test/log` | Return requests observed by the target. |
| `GET /__test/reset` | Clear the log and reset behavior flags. |
| `GET /__test/:flag?value=<json>` | Set `sessionValid`, `pageStateAuth`, drift shape, or latency. |

The `__test` control plane is intentionally unauthenticated and must never be copied into a real
target. It exists only so tests can prove whether the target saw zero, one, or multiple requests.

## WebSocket protocol inventory

The extension connects to `ws://127.0.0.1:<port>/ws?token=<install token>`.

Extension to daemon:

- `hello`, `pong`
- `exchange.session.start`, `exchange.append`, `exchange.annotate`, `exchange.session.stop`
- `relay.response`

Daemon to extension:

- `welcome` with heartbeat interval, then `ping` every 20 seconds
- `relay.request` with id, execution origin, URL, method, non-secret headers/body, credential-source
  descriptors, and timeout

Requests and responses are correlated by UUID. A disconnect fails all in-flight calls immediately;
the extension buffers capture messages and drains them in order after reconnecting.

## Recipe/API contract checks

A saved recipe is invalid unless:

- version and kebab-case recipe name are valid;
- tool names are unique snake_case;
- approved tools reference at least one fixture;
- approved destructive tools require a boolean `confirm` parameter;
- no credential value appears anywhere in the serialized recipe; and
- the request method is GET, HEAD, POST, PUT, PATCH, or DELETE.

At runtime, only approved tools are exposed. GET/HEAD arguments not consumed by path templates
become query parameters; other REST arguments become a JSON body; GraphQL stores the document and
uses arguments as variables. The CLI trims to `primary_payload_path` unless `raw=true` and applies
the configured response-size cap. CLI and MCP calls validate arguments against the inferred JSON
Schema. A caller using the authenticated `/relay` HTTP endpoint directly bypasses that surface
validation, but still cannot bypass daemon-owned destructive confirmation, degradation,
connectivity, and rate-limit guards.

## Failure record

For every failure, capture:

- commit SHA and whether the working tree was already dirty;
- exact command and test name;
- first relevant stack trace or API response;
- daemon port and `douze status` output, with token values removed;
- whether the fixture target received zero, one, or multiple requests; and
- paths to Playwright traces or screenshots.

Never paste `$DOUZE_HOME/token`, cookies, authorization values, live response bodies, or a real
account's stored browser profile into an issue.

## Known verification gaps as of 2026-08-06

- `TASKS.md` still has C-1 (real Openfort read) and C-2 (second recipe without reconnect) open.
- The headless implementation and unit tests exist, but the tracked `douze headless enable|disable`
  command and browser-closed E2E files do not exist in the current source tree, and the primary
  `/relay` route always uses `RelayBridge`. Do not report headless as end-to-end verified.
- The README release link still uses the `OWNER` placeholder and no release has been tagged, so
  install verification from published artifacts is not yet possible.
- The browser harness assumes the fixed macOS Helium path and cannot run headless.
