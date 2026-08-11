# Douze intern verification flow

Use this guide to verify Douze without touching a real account first. It covers the extension —
which is the product — and the two stateless pipes that attach to it: the cloud relay and the local
bridge. There is no daemon, no `douze` CLI, no `.mcpb`, and no headless mode; if you find a document
or a comment that mentions one, it is stale and the code wins.

Everything here is a check you can run and a piece of evidence you can record. Where something has
never been verified, it is in [Known verification gaps](#known-verification-gaps), not softened into
a claim.

## Pass criteria

An intern can mark the application verified only when all of these are true:

- Build, typecheck, lint, and unit tests pass across every package.
- The extension's smoke run boots the built extension in a real browser and records exchanges.
- Cookie and page-state authentication both reach the fixture API.
- No cookie, bearer token, CSRF value, password, or API key reaches persisted artifacts —
  IndexedDB, `chrome.storage.local`, or a fixture.
- An exchange carrying a JWT is refused by the single write path, not stored and reported.
- A recipe exported as YAML and re-imported round-trips byte-identically.
- Both pipes complete list + call against the fixture with no daemon on the machine.
- A destructive call is refused on the relay path whatever it sends, and succeeds on the paired
  bridge path only with `confirm: true`.
- An unpaired bridge is refused before the MCP host is ever told anything attached.
- A second approved recipe appears in a running local MCP session without reconnecting.

## System flow

```mermaid
sequenceDiagram
    actor User
    participant Page as Signed-in dashboard
    participant Ext as Chrome extension
    participant Host as Relay or bridge
    participant Client as MCP client
    participant API as Dashboard API

    User->>Ext: Watch this site
    Ext->>Page: Register interceptor, reload
    User->>Page: Perform normal workflow
    Page->>API: Authenticated fetch/XHR
    Ext->>Ext: Redact, then CaptureStore.appendExchange (the gate)
    User->>Ext: Done
    Ext->>Ext: Infer candidates, review page, approve
    Ext->>Ext: Write recipe + fixtures to chrome.storage.local
    Ext->>Host: surface.push (filtered by this attachment's trust)
    Host-->>Client: notifications/tools/list_changed
    Client->>Host: tools/call
    Host->>Ext: tool.call{id, name, args, trust}
    Ext->>Ext: Guards: degraded, trust, confirm, rate limit
    Ext->>Page: Read current page-state credential if declared
    Ext->>API: fetch from browser context; credentials included when required
    API-->>Ext: JSON response
    Ext->>Ext: classify, shape, gateResult
    Ext-->>Host: tool.result{id, result | error}
    Host-->>Client: MCP result
```

The extension always dials outward and never listens. Neither pipe can wake it: `chrome.alarms`
(30-second floor) is the only thing that revives an evicted worker, which is why both hosts hold an
inbound `tools/call` for 40 seconds before answering it as offline.

## 1. Prepare an isolated run

Prerequisites are Node 22+, pnpm, and Helium at
`/Applications/Helium.app/Contents/MacOS/Helium`. Browser runs are macOS-only in the current
harness, run headed, and use one worker.

Use a scratch browser profile. Never load a build under verification into a browser profile that is
signed into anything you care about.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected result: every command exits zero. `pnpm lint` is `oxlint packages e2e fixtures` and must
report zero warnings, not just zero errors. Do not update dependencies to make any of this pass;
record the failing command and the first relevant error.

Per-package tests, when you need to name the boundary you are verifying:

```sh
pnpm --filter @douze/shared    test   # redaction, recipe schema, protocol
pnpm --filter @douze/studio    test   # inference, deterministic descriptions, merge, promotion
pnpm --filter @douze/extension test   # store, recipes, guards, attach, review, HAR, background
pnpm --filter @douze/mcp-host  test   # MCP termination and the attachment protocol
pnpm --filter @douze/relay     test   # sessions, tenancy, wake grace, log discipline
pnpm --filter @douze/bridge    test   # stdio transport, loopback WS, pairing
```

## 2. The extension standing alone

Nothing in this section needs either pipe. Run it first: if capture, storage or review is broken,
every pipe result below is meaningless.

```sh
pnpm exec tsx fixtures/server.ts                       # the fixture dashboard on 127.0.0.1:4180

DOUZE_TEST_ORIGIN=http://127.0.0.1:4180 \
  pnpm --filter @douze/extension build                 # bakes the fixture origin in
pnpm --filter @douze/extension smoke
```

`smoke.mjs` proves the built artifact actually loads: Helium boots it, the MV3 service worker runs
its top-level registrations, the popup renders, and a session on the fixture records real
exchanges. Without a fixture on 4180 the capture half is skipped and the rest still runs, so check
what it reported rather than only its exit code.

### Storage and the single write path

`packages/extension/src/store.ts` holds captures in IndexedDB — sessions, exchanges ordered by
`(session_id, position)`, annotation spans — which is why the manifest carries `unlimitedStorage`.

`CaptureStore.appendExchange` is **the only method that writes an exchange**. It re-applies
`redactUrl` / `redactHeaders` / `redactBody` even though the capture pipeline already ran them, then
scans the *whole record* with `findSurvivingSecrets` and throws rather than storing anything that
survives. `db` is private and no object-store access is exported, so from outside that file there is
no way to persist an exchange that skipped the gate.

| Check | Required evidence |
|---|---|
| Capture | POST and GET request/response bodies persist; CSS and analytics are absent. |
| Redaction | `authorization` and `password` are `«redacted:…»` placeholders; originals appear nowhere in IndexedDB. |
| The gate | An exchange carrying a JWT throws `refusing to persist exchange <id>: credential at <path>` and is absent from the store. |
| Ordering | Exchanges read back in `position` order from the compound index, not from a sort. |
| Annotations | A note with nothing captured since the previous one produces an EMPTY span (`end < start`), not a claim on the next exchange. |

### Recipes, the surface, and YAML export/import

`packages/extension/src/recipes.ts` keeps recipes in `chrome.storage.local` under `recipe:` and
fixtures under `fixture:`, and `chrome.storage.onChanged` is the hot-reload signal. A recipe is
stored **as its YAML source string**, which is what makes export byte-identical.

| Check | Required evidence |
|---|---|
| Validation | An invalid recipe never reaches storage; the last good version keeps serving. |
| Fixture gate | A fixture with a credential-shaped value throws `refusing to store fixture "<ref>": credential at …`. |
| Surface | Only `approved` tools in `enabled` recipes appear, named `<recipe>_<tool>`. |
| Degradation | A missing fixture degrades the tool with a reason rather than hiding it. |
| Revision | `revision` bumps only when the tools actually change; a parse error alone does not bump it. |
| Round trip | `exportRecipe` → `importFiles` reproduces the YAML byte for byte, comments and key order intact. |
| Atomicity | An import with any error or name conflict writes nothing at all. |

### Review and inference

`ReviewSession` (`review-session.ts`) is the old daemon studio session on extension storage; it
reuses `@douze/studio/browser` wholesale rather than re-implementing inference or descriptions. The
review page is an extension page — `chrome.runtime.getURL('review.html?session=<id>')`, opened by
the service worker — which removes the expired-link failure mode the daemon's HTTP review UI had.

Verify by hand: candidates group into read / write / destructive; only reads are bulk-enabled;
name and description edits persist; save writes fixtures first and then the validated recipe.

### HAR import

`importHar` (`har.ts`) does no redaction of its own **by design** — it routes every entry through
`CaptureStore.appendExchange`, so the same gate applies. Refusals are reported per entry in
`refused[]` and do not abort the import; `imported + skipped + refused.length` must equal the number
of entries in the file. `fixtures/orders.har` is the input to use.

## 3. The attachment protocol and both pipes

`packages/mcp-host` is the one MCP implementation both pipes use. Two of it would be the failure
this design exists to avoid, so check that neither transport answers MCP itself.

What the host owns: `initialize`, `ping`, `tools/list`, `tools/call`; protocol version
`2025-06-18` with older ones echoed back when asked for; `capabilities.tools.listChanged` declared
**unconditionally**, empty surface or not; a 120 s per-call ceiling.

| Check | Required evidence |
|---|---|
| Answered from cache | `initialize` and `tools/list` succeed with the extension detached. |
| listChanged | A `surface.push` that changes the surface emits `notifications/tools/list_changed`; an identical one does not. |
| Empty surface | A host with zero tools still advertises the tools capability and answers `tools/list` with `[]`, never "Method not found". |
| Call ids | A `tool.result` carrying `1` cannot settle a call waiting on `"1"`. |
| Disconnect | `setAttached(false)` fails everything in flight at once with `extension_disconnected`, and **re-sends nothing**. |
| Trust | `trust` is set at host construction and stamped on every `tool.call`; nothing a client sends can reach it. |

On the extension side (`attach.ts`), the mirror check is the one that matters most: the `trust` on
an inbound frame is **deliberately dropped**, and the level used is derived from what was dialled. A
test that only asserts the host's stamp has not verified this.

## 4. The guards

`packages/extension/src/guards.ts` is the only place policy lives. Both pipes stamp a trust level
and **neither enforces anything**.

The table, enforced twice:

| | `remote` (relay) | `local` (paired bridge) |
|---|---|---|
| read | always | always |
| write | opt-in per attachment | always |
| destructive | never, no setting restores it | allowed, `confirm: true` required |
| result secret gate | enforced, `expose` to exempt | enforced, `expose` to exempt |

- **Push time** — `attachedSurface` filters, so a hosted client never sees a tool that would always
  be refused.
- **Call time** — `checkPolicy` refuses whatever was pushed, because a host that lies about what it
  sent must not get through.

Both halves are required and both must be tested. Filtering alone is a UI courtesy, not a control:
verify the call-time refusal by sending a `tool.call` for a destructive tool that was never on the
pushed surface.

| Check | Required evidence |
|---|---|
| Destructive, remote | Refused as `trust_refused`, **not** `confirm_required` — the second would invite a retry that can never work. Zero target requests. |
| Write, remote, no opt-in | Refused as `trust_refused`. Zero target requests. |
| Write, remote, opted in | Succeeds; the surface pushed after the opt-in contains it. |
| Destructive, local | Refused without `confirm: true`, succeeds with it. |
| Degraded | Refused before any trust check, because "this tool is broken" outranks "you may not call it". Zero target requests. |
| Unknown tool | `unknown_tool`, zero target requests. |
| Expiry | A target 401/403/login redirect becomes `session_expired`; exactly one target request was made and none retried. |
| Rate limit | Excess calls queue per tool; a wait over `RATE_WAIT_MAX_MS` (20 s) is refused as retryable `rate_limited` naming the seconds, never parked across a worker eviction. |
| Result size | A result over 32 KB is cut on a UTF-8 boundary and `returned_bytes` is at or under the cap. |
| Result gate | A result carrying a credential-shaped value is withheld, naming the tool and the paths; the value itself is absent from the refusal. |
| Audit | Every call appends `{at, tool, trust, outcome, duration_ms, status?}` and **no arguments** — that is deliberate, not an omission. |

## 5. The bridge: pairing at full trust

`packages/bridge` is stdio JSON-RPC on one side and a loopback WebSocket the extension dials on the
other, over one `McpHost`. It holds no state except the pairing credential.

**Loopback is not consent.** `127.0.0.1` proves only that the peer is on this machine, and every
process on this machine can dial it; without a shared secret the first thing to connect would
inherit `local` trust and with it destructive tools.

| Check | Required evidence |
|---|---|
| Code | 8 characters from a Crockford-style alphabet (~39 bits), printed to **stderr only**; stdout carries protocol and nothing else. |
| Refusal | An unpaired socket is closed with 1008 **before the host is told anything attached**. |
| Attempt cap | Ten failed attempts and the process refuses every connection until the client restarts it. |
| Secret | 32 random bytes handed back on the raw `welcome`; only its sha256 is written, to `$DOUZE_HOME/bridge.json` (default `~/.douze/bridge.json`), mode `0600` — set by an explicit `chmodSync`, because `mode` applies at creation only. |
| Timing | Both the code and the secret comparison use `timingSafeEqual`. |
| Ports | 8912–8916, walked in order; several bridges are live at once because a bridge is per MCP client. |
| Wake grace | A `tools/call` with nothing attached is held 40 s; `initialize` and `tools/list` never wait. |
| Extension pin | The `secret` is read off the **raw** `welcome` — the `HostFrame` schema strips it, so strict parsing would drop it — and pinned in extension storage. |

The residual risk is stated in `packages/bridge/README.md` and must not be sanded off in a report:
`0600` stops other *users*, not other *code* running as you. Local malware that already has
execution as your user reads the file, and also reads your browser profile and your SSH keys.

## 6. The relay: session ownership and the wake grace

`packages/relay` terminates MCP rather than forwarding it. One `McpHost` per session answers
`initialize` and `tools/list` from the surface the extension last pushed; only `tools/call` goes to
the browser. That is what lets a connector added while Chrome was closed list its tools instead of
looking broken.

| Check | Required evidence |
|---|---|
| Session id | `initialize` mints one and returns it in `Mcp-Session-Id`; an unknown one is a 404 so the client re-initializes. |
| Tenancy | Interleaved calls across two enrolled endpoints each return their own tenant's result; one tenant's session id is a 404 on the other's URL. |
| Wake grace | A `tools/call` with no live socket is held **40 s** and then refused; `initialize` and `tools/list` never wait. |
| Socket loss | In-flight calls fail at once with retryable `extension_disconnected` and **none is re-sent** — a tool can be a write. |
| Surface cache | One cached surface per endpoint, replaced wholesale by each `surface.push` and fanned out to every live session, including one created later. |
| Caps | 1 MB bodies, 8 in flight, 4 sessions per endpoint, 120 s per call; a duplicate in-flight JSON-RPC id is a 409. |
| Error shape | In-flight / duplicate-id / too-many-sessions refusals come back as `200` with a JSON-RPC error, because an MCP client renders that and drops an HTTP error body. |
| No stream | `GET /m/<secret>` is 405; there is no server-initiated stream in v1. |
| Log discipline | Sweep every stderr line of a full register → connect → initialize → call → close run: no payload, tool name, description, session id, token, path secret, or bearer. |

## Boundary inventory

The daemon-era boundaries — an install token, a loopback HTTP API, `/pair` extension pinning — are
gone with the daemon. Three remain, and they are the whole authenticated surface of the product.

### A. Target-site authentication

Authentication to the dashboard being automated. Douze does not implement login and stores no
credential.

| Mode | How it works | What is persisted | Required verification |
|---|---|---|---|
| Cookie | The extension executes `fetch` in a tab on the execution origin with `credentials: include`; Chrome attaches cookies, HttpOnly included. | `{kind: cookie}` descriptor only. | Fixture server receives the cookie; stored artifacts do not contain it. |
| Page state | Capture discovers the storage expression that produced a header or a credential-shaped path segment. At call time the extension reads the current value in the page's MAIN world and attaches it from the isolated world. | Expression, destination header/parameter, and prefix — never the value. | Bearer and CSRF fixture cases succeed; storage contains neither value. |
| Cross-origin API | The recipe stores `page_origin` for the dashboard and `target.base_url` for the API; execution happens from the dashboard tab so storage and CORS origin match. | Origins and credential locations only. | A dashboard whose API is on another host retains exchanges and relays successfully. |

Session expiry is a target 401, 403, or a redirect to a login path. There is no retry and no refresh
path anywhere in the product now — the browser is the only executor.

### B. Extension-internal message guards

The extension's own contexts are the trust boundary that replaced loopback.

- `chrome.runtime.onMessage`: every non-capture command requires
  `sender.url?.startsWith('chrome-extension://')`. A failing sender gets no response at all.
  `sender.tab === undefined` is explicitly **not** the discriminator.
- Capture batches are gated separately: a `sender.tab?.id` is required, and the frame's own
  `sender.origin` must be in the recording session's origin list. Nothing in the message body
  decides this. The batch is truncated at 200 entries.
- `chrome.runtime.onMessageExternal` is not wired up anywhere, which is why the scheme test
  suffices. **If anyone adds an external handler, this guard stops being sufficient** — check for
  one before signing off.
- Host permissions are requested per target at record time (`optional_host_permissions`), as the
  first statement of a click handler because Chrome requires a user gesture. `debugger` is an
  optional permission behind a checkbox.
- The review page is reachable only as `chrome-extension://…/review.html?session=<id>`; the session
  id is a plain query parameter with no token, on the grounds that only this extension can open that
  scheme.

Verify with `pnpm --filter @douze/extension test`, which must cover the sender guard, the capture
origin gate, and the batch cap.

### C. Bridge pairing

Section 5. The credential file, the ten-attempt cap, the 1008-before-attach refusal, and the
stderr-only code are the four things a report must state individually.

### D. Relay endpoint authentication

| Route | Auth |
|---|---|
| `POST /register` | none, rate-limited per caller |
| `POST /rotate`, `DELETE /register` | `x-douze-relay-token` |
| `WS /ws` | first frame `hello{token}` within 5 s; anything else closes 1008 |
| `POST /m/<secret>` | the secret in the path, plus `Authorization: Bearer` if one was registered |
| `GET /health` | none |

The endpoint token and the URL secret are independent randoms, and the relay stores only sha256
hashes of both (and of any bearer), so a memory dump of a running relay hands over neither. The
registration rate limit counts per socket address, which behind a terminator is the terminator —
`TRUST_PROXY=1` charges it to the forwarded caller instead, and must be set **only** where that
proxy is the sole route to the port.

**Capability scoping is enforced in the extension, not at the relay and not at the platform.** Do
not accept a relay-side test as evidence for the trust table.

| Boundary | What crosses it | Protection |
|---|---|---|
| Page ↔ extension | raw traffic, credentials | redaction before anything is stored; the write-path gate |
| Extension ↔ bridge | MCP frames: tool args and full result bodies | loopback, paired credential, `local` trust |
| Extension → relay | the same frames | outbound-only WSS, endpoint token, TLS; `remote` trust |
| Relay ↔ AI platform | the same frames | per-user secret URL, optional static bearer, TLS |
| Platform ↔ model | tool results enter the conversation | out of our control — disclosed, not mitigated |

Three facts are disclosed rather than mitigated, and `README.md` states them without softening: the
relay operator can read and inject traffic; the platform stores whatever the tools return; those
result bodies are live dashboard data. The relay additionally holds every tool **name, description
and input schema** an endpoint has pushed, because that is what `tools/list` is answered from —
which describes the systems a user has automated whether or not anyone ever calls them. A
strictly-local user must never connect a hosted assistant. The residual nobody here owns a lever for
is prompt injection through attacker-authored dashboard content, bounded by the read-only default
and the absolute destructive ban on the remote path.

## Secret handling

Redaction runs at every persistence boundary, and two rules decide what may be written:

- **Key names**: authorization, cookie, set-cookie, API key, CSRF/XSRF, proxy-authorization, and the
  body/query equivalents (password, token, secret, refresh/access token, client secret, private key,
  session, credential).
- **Value shape**: JWTs, Basic/Bearer strings, `sk_`/`pk_`/`rk_`-prefixed keys, and long
  high-entropy runs, **whatever the field is called**. URLs are judged part by part — path segments
  and decoded query values — because judging a whole URL as one string once refused 30 of 31
  exchanges from a real dashboard.

Placeholders preserve type and length (`«redacted:string:28»`) so schema inference still sees the
right shape. `findSurvivingSecrets` is the final gate at each boundary, and detection and removal
share one test so the gate and the redactor cannot disagree.

Redaction protects what Douze *stores*. A live tool result is not a fixture — it is whatever the
target returned a moment ago — so `gateResult` is a separate last check before anything leaves the
browser at all, per trust level, with a per-tool `expose` list under `attach:expose` as the only
override.

**The artifact sweep runs against extension storage.** It used to be `e2e/metrics.mjs` walking
`DOUZE_HOME`, which no longer exists. `e2e/artifacts.spec.ts` replaces it: it records a session
carrying every secret shape in the pattern list, then sweeps `chrome.storage.local` and IndexedDB
through the service worker, and asserts the exchanges are present so the sweep cannot pass by
finding nothing. It also carries the build guard — the worker bundle must contain no
code-generating call site beyond zod's one probe, which `zod-config.ts` now disables.

## Verify the whole path

```sh
pnpm e2e            # Playwright, testDir ./e2e, Helium headed, one worker
```

`pnpm verify:e2e` names the five specs that must pass before a release. The suite was deleted with
the daemon and rebuilt under T-015.14; **its coverage is exactly what `e2e/README.md` claims and
nothing more**, so read that file before deciding what a green run
proves. `e2e/global-setup.ts` builds the extension with the fixture origin baked into
`host_permissions`, because `chrome.permissions.request` needs a user gesture Playwright cannot
supply.

```sh
pnpm --filter @douze/studio eval   # agent tool-selection accuracy on the reference recipe
```

## Manually verify the product flow

Use a scratch browser profile and the local fixture.

1. `pnpm --filter @douze/extension build`, then load `packages/extension/dist` unpacked.
2. `pnpm exec tsx fixtures/server.ts`.
3. Open `http://127.0.0.1:4180` and establish the fixture cookie.
4. Click **Watch this site**, use **Create order** and **List orders**, add a note, click **Done**.
5. Confirm the review page lists inferred candidates. Bulk-enable reads only; inspect write and
   destructive candidates individually.
6. Save. Confirm the popup shows the tools for that site.
7. Build and start the bridge, pair it with the code it prints, and call the approved read from a
   real MCP client.
8. Confirm the fixture's `/__test/log` shows exactly one authenticated target request.
9. For C-2: keep that session open, record and approve a second target, and require a
   `notifications/tools/list_changed` followed by both recipes in `tools/list`, with no restart.

Do not approve or call a destructive tool merely to complete this checklist.

## Failure record

For every failure, capture:

- commit SHA and whether the working tree was already dirty;
- exact command and test name;
- first relevant stack trace or API response;
- which pipe was in the path, and the trust level the extension derived;
- whether the fixture target received zero, one, or multiple requests;
- paths to Playwright traces or screenshots.

Never paste a relay URL or endpoint token, `~/.douze/bridge.json`, cookies, authorization values,
live response bodies, or a real account's browser profile into an issue.

## Known verification gaps

Stated plainly, as of 2026-08-11. Each is something nobody has done, not something that merely
lacks a test.

- **C-1 is still open and can no longer be closed the way it was being closed.** No recording
  against a real authenticated dashboard has produced a completed read since the rewrite, and the
  daemon path that the last attempt ran on has been deleted. It must be redone on the extension.
- **Q5 is still open.** Whether MAIN-world interception survives real sites' CSP and page hardening
  has never been tested on three real targets. The `chrome.debugger` fallback exists but its being
  needed would be a product finding, not a configuration detail.
- **There is no Chrome Web Store listing.** It has not been opened. Review latency and the
  data-disclosure wording are on the critical path and neither is code. Note also that
  `packages/extension/public/manifest.json` currently describes Douze as "Nothing leaves your
  computer", which stops being true the moment a hosted assistant is connected — that is a
  disclosure defect to fix before submission, not after.
- **No release exists and there is nowhere to publish one.** No `v*` tag has been pushed and
  `git remote -v` prints nothing, so installation from a published artifact cannot be verified at
  all. `@douze/bridge` is likewise `private` and unpublished, so the `npx @douze/bridge` invocation
  in its own README does not work; run the built `dist/index.js` instead.
- **The e2e suite is only as good as `e2e/README.md` claims.** Fifty-one specs were deleted with the
  daemon and the replacement was written against that file's requirements list. Read it before
  treating a green run as coverage of anything it does not name.
- **The artifact secret sweep does not exist on the new architecture.** See the note under
  [Secret handling](#secret-handling). C-4 is unverified until it does.
- **HAR import and YAML export/import have no user interface.** `importHar`, `exportRecipe`,
  `exportAll` and `importFiles` are implemented and unit-tested but have no caller outside their own
  tests — no file picker, no download, no message type. They can be verified as APIs and not as
  features.
- **Model-written descriptions are not implemented.** Descriptions are deterministic only
  (`describeSync`), and there is no options page in the manifest to put a toggle on. The 96.4%
  template-only score against a ≥90% bar is why this is acceptable, not evidence that the model path
  works.
- **No hosted client has ever attached.** Connecting is wired end to end and unit-tested against a
  faked relay, but no ChatGPT, claude.ai or Dust connector has been pointed at a real endpoint, so
  how those clients render a JSON-RPC error, a 404 session, or a non-SSE response is still
  assumption. This is the single largest untested claim in the product.
- **The recipe schema still accepts `auth.mode: headless`** so an older recipe parses, but nothing
  reads it: every call executes in the browser. The keychain and refresh-endpoint fields that mode
  needed are gone.
- **No server-initiated stream on the remote surface.** `GET /m/<secret>` is 405, so a hosted client
  sees new tools only when it next polls `tools/list`. That is a weaker guarantee than C-2 requires
  of the local path, where stdio carries `notifications/tools/list_changed` properly.
- **Cloudflare closes a proxied request at ~100 s while the relay holds one for 120 s**, so a call
  slower than that returns a Cloudflare error page instead of a JSON-RPC error the client can read.
  Untested, because no call has yet taken that long.
- **The browser harness assumes a fixed macOS Helium path** and cannot run headless.

## Deployed relay (2026-08-11)

One relay runs at `https://douze.jamalavedra.com`: a Cloudflare tunnel in front of a systemd user
unit on `coolify-fsn1` bound to `127.0.0.1:9787` with `TRUST_PROXY=1`, serving one bundled file
built by `pnpm --filter @douze/relay build`.

It was verified end to end against **the daemon that has since been deleted** — register, WebSocket
upgrade through Cloudflare, `initialize`, `tools/list` routed by `Mcp-Session-Id`, 404 on an unknown
session, immediate 503 on a dropped socket, a destructive tool refused with `confirm: true` — and
the log through all of it carried event names, durations and endpoint hash prefixes only. Those
results are evidence about the relay and about Cloudflare. **They are not evidence about the
extension attaching**, which is a different client on the same socket and has not been run against
this deployment.
