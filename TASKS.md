# Recon — Implementation Task Tracker

Recon watches you use an authenticated dashboard for five minutes and turns the traffic into tools Claude Desktop, Claude Code, and the shell can call. Tool calls execute inside your signed-in browser via a relay, so no credential is ever extracted or stored. Recipes are versioned YAML interpreted at runtime, so a new target or an edited description reaches a running client in seconds with zero re-registration.

```
  Chrome ext ──ws──▶ recond ◀──http/loopback──┬── recon --mcp   (stdio, launched by Claude)
                                              └── recon jira create-issue   (shell)

       recon studio ──▶ recipes/*.yaml ──▶ recond   (dev-time only)
```

Golden path (PRD 5.2):

```
  recon start                                  # recond up, extension connects
  recon bundle && open recon.mcpb              # once, ever — Claude Desktop
  recon mcp add --agent claude-code            # once, ever — Claude Code

  # click record in the extension, do the workflow, annotate, stop
  recon studio                                 # infer, review, approve
  # → tools are live in Claude Desktop within seconds; no reinstall

  recon doctor jira                            # later: has the target drifted?
  recon eject jira --out ./jira-tools          # optional: an artifact you own
```

**Progress: 33/147 tasks complete** (86 implementation, 48 verification)

Monorepo: pnpm workspaces, TypeScript, Node 22 / Bun. Packages: `packages/shared`, `packages/extension`, `packages/recond`, `packages/studio`, `packages/cli`. Runtime built on the `incur` npm package (wevm): Zod schemas drive the CLI, `--mcp` exposes the same commands as MCP tools. E2E: Playwright driving Helium (`/Applications/Helium.app`) with the unpacked MV3 extension, against a local fixture SPA + fixture server in `e2e/fixtures/`.

## Dependency graph

```
WO-003 ─┬─▶ WO-001 ─▶ WO-002              (extension lane)
        ├─▶ WO-005 ─▶ WO-006 ─▶ WO-007    (studio lane)
        └─▶ WO-004 ─▶ WO-008 ─▶ WO-009 ─▶ WO-010   (runtime lane; WO-009 also needs WO-001)
                          │
T-008.1 spike (no deps, run in M0)

WO-004 + WO-009 ─▶ WO-011   (drift)
WO-007 + WO-008 ─▶ WO-012   (eject)      [P with WO-013]
WO-009          ─▶ WO-013   (headless)   [P with WO-012]
```

Concurrent after WO-003 lands: the **extension lane** (WO-001→002), **studio lane** (WO-005→006→007), and **runtime lane** (WO-004→008) are independent of each other and can be built in parallel. WO-009 joins the extension and runtime lanes. WO-012 and WO-013 are mutually independent. The PRD's own milestones (5.1): M0 = WO-003 (HAR path) + WO-005 + WO-006 + incur spike; M1 = WO-001/002/004/007/008/009/010; M2 = WO-011 + migrations; M3 = WO-012/013 + packaging. Order below reorders within that grouping for the earliest end-to-end demo.

---

## WO-003 — recond foundation: relay daemon, capture store, control CLI, HAR import

Build order #1 — everything depends on this substrate (shared types, daemon, storage, e2e harness), and HAR import unblocks the whole studio lane before the extension exists.

### Tasks

- [x] T-003.1 — Scaffold pnpm workspace: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` (strict flags per global standards), `.oxlintrc.json`, vitest workspace config
- [x] T-003.2 — Recipe schema: TypeScript types + Zod schema for the `Recipe` model (version, name, enabled, target.base_url, auth.mode, auth.credential_source descriptor, tools[] with name/description/side_effect/confidence/observations/request/response/fixtures/flags) in `packages/shared/src/recipe.ts`
- [x] T-003.3 [P] — Capture types: `CaptureSession`, `Exchange` (headers, bodies, timing, provenance, `body_missing`/`background` flags), `AnnotationSpan` in `packages/shared/src/capture.ts`
- [x] T-003.4 [P] — Redaction module: credential-header list (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-csrf-token`, user additions), secret-field list (`password`, `token`, `secret`, `apiKey`, `refresh_token`, user additions), stable placeholders preserving type + length, in `packages/shared/src/redaction.ts`
- [x] T-003.5 [P] — WS protocol types: `exchange.*` (extension→daemon) and `relay.*` (daemon→extension) message families in `packages/shared/src/protocol.ts`
- [x] T-003.6 — Daemon process + lifecycle: entry point, PID/port file, single-instance detection with exit-and-message on second start, in `packages/recond/src/daemon.ts`
- [x] T-003.7 — Hono app on loopback with per-install token middleware (token generated on first run, stored in config dir) in `packages/recond/src/http.ts`
- [x] T-003.8 — Extension WebSocket endpoint: accept `ws://127.0.0.1:<port>`, heartbeat inside the 30-second MV3 idle window, connection-state tracking, in `packages/recond/src/ws.ts`
- [x] T-003.9 — CaptureStore on SQLite: persist sessions/exchanges/annotation spans, enforce redaction invariant before write (reject any exchange with credential-shaped values), serve exchange queries, in `packages/recond/src/capture-store.ts`
- [ ] T-003.10 — CLI scaffold on incur: `recon start|stop|status|sessions` commands in `packages/cli/src/index.ts` + `packages/cli/src/commands/daemon.ts`
- [ ] T-003.11 — Daemon client with auto-start: detect recond down, spawn it, wait for reachability, proceed; recovery after daemon restart, in `packages/cli/src/daemon-client.ts`
- [x] T-003.12 — HAR import: convert HAR entries to a Capture Session applying live-capture noise filtering + redaction, mark body-less entries `body_missing`, `recon import <file> --name <n>`, in `packages/recond/src/har-import.ts` + `packages/cli/src/commands/import.ts`
- [x] T-003.13 [P] — E2E harness: Playwright config launching Helium (`/Applications/Helium.app`) with the unpacked extension, fixture SPA (orders app with auth, analytics beacon, CSS asset, GraphQL endpoint, polling mode, page-state-token mode, delay mode), fixture server recording every request it receives, in `e2e/playwright.config.ts`, `e2e/fixtures/spa/`, `e2e/fixtures/server.ts`, plus `fixtures/orders.har`

### Verification

- [x] V-COV_RUN_003.1 — Starting a second `recond` exits non-zero with a message naming the running instance; only one port bound (`e2e/daemon/lifecycle.spec.ts`)
- [x] V-COV_RUN_003.2 — With recond stopped, a CLI command auto-starts it and completes; after killing recond, the next command recovers with no user action (`e2e/daemon/lifecycle.spec.ts`)
- [x] V-COV_CAP_006.1 — `recon import fixtures/orders.har --name orders-har` yields a session with only JSON exchanges from the primary origin and `authorization` values as placeholders (`e2e/daemon/har-import.spec.ts`)
- [x] V-COV_CAP_006.2 — Importing a HAR whose entries lack response content marks every exchange `body_missing` and discards none (`e2e/daemon/har-import.spec.ts`)

---

## WO-005 — Inference engine

Build order #2 — M0's first kill-question feeds from HAR sessions, no extension needed; runs parallel with WO-004.

### Tasks

- [ ] T-005.1 — Endpoint templating: collapse same-method exchanges differing in one path segment into `EndpointTemplate` with named parameter (from response `id`-like field, else singular preceding static segment), in `packages/studio/src/inference/templating.ts`
- [ ] T-005.2 [P] — Schema inference: required iff present in every observation, open enums for <12 distinct string values over ≥3 observations, `sparse` + confidence ≤0.4 for single-observation tools, emit JSON Schema convertible to Zod without manual editing, in `packages/studio/src/inference/schema.ts`
- [ ] T-005.3 [P] — GraphQL splitting: group by operation name, one candidate per operation, input schema from observed `variables`, store operation document, derive names for anonymous ops (marked `derived_name`), exclude 200-with-`errors` exchanges from schema inference, in `packages/studio/src/inference/graphql.ts`
- [ ] T-005.4 [P] — Side-effect classification: GET/HEAD → `read`, POST/PUT/PATCH/DELETE → `write`, destructive-pattern match (`delete`, `remove`, `purge`, `cancel`, `refund`, `revoke`) → `destructive`, in `packages/studio/src/inference/side-effects.ts`
- [ ] T-005.5 [P] — Primary Payload Path selection + pagination detection (page/cursor params, recorded pagination style) in `packages/studio/src/inference/payload.ts`
- [ ] T-005.6 [P] — Confidence scoring from observation count, schema stability, side-effect certainty, in `packages/studio/src/inference/confidence.ts`
- [ ] T-005.7 — Engine orchestrator: exchanges → scored `CandidateTool` records, every candidate traceable to ≥1 exchange, deterministic and replayable with no model calls, in `packages/studio/src/inference/engine.ts`

### Verification

- [ ] V-COV_INF_001.1 — GETs to `/orders/1042|1043|1044` collapse to exactly one candidate with path `/orders/{orderId}`, parameter named from the response `id` field (`e2e/studio/inference.spec.ts`)
- [ ] V-COV_INF_001.2 — Three POSTs where `note` appears once yield `note` optional and always-present fields required (`e2e/studio/inference.spec.ts`)
- [ ] V-COV_INF_004.1 — `/graphql` session with `GetIssue`, `CreateIssue`, `GetIssue` yields two candidates with variables-derived schemas (`e2e/studio/graphql-inference.spec.ts`)
- [ ] V-COV_INF_004.2 — A `CreateIssue` returning HTTP 200 with populated `errors` did not contribute to the response contract (`e2e/studio/graphql-inference.spec.ts`)

---

## WO-006 — Naming and description generation

Build order #3 — M0's 90% selection-accuracy exit criterion lives here; needs WO-005 candidates.

### Tasks

- [ ] T-006.1 — Naming: verb-object snake_case from method/path/annotation/provenance, within-recipe collision disambiguation from distinguishing parameters, in `packages/studio/src/descriptions/naming.ts`
- [ ] T-006.2 — Model client: configurable endpoint with local-model override taking precedence over remote provider, in `packages/studio/src/descriptions/model-client.ts`
- [ ] T-006.3 — DescriptionWriter: ≤3-sentence what/returns/when descriptions, Annotation Span notes prioritized over UI provenance, redaction assertion on every model input payload (fail closed if a credential-shaped value is present), in `packages/studio/src/descriptions/writer.ts`
- [ ] T-006.4 [P] — Offline eval harness scoring tool-selection accuracy against a labeled natural-language task set for the reference recipe, in `packages/studio/eval/selection.ts` + `packages/studio/eval/tasks/reference.yaml`

### Verification

- [ ] V-COV_INF_006.1 — Candidate with span note "transitions an issue to done" and provenance "Save" gets a description reflecting the transition intent, not the button label (`e2e/studio/descriptions.spec.ts`)
- [ ] V-COV_INF_006.2 — With a recording mock model endpoint, no request to it contains the original credential value from the session (`e2e/studio/descriptions.spec.ts`)
- [ ] V-COV_INF_006.3 — Eval harness over the labeled task set reports selection accuracy ≥90% (`e2e/studio/descriptions.spec.ts`)

---

## WO-004 — Recipe registry and hot reload

Build order #4 — the install-once mechanism; needs only WO-003 + shared recipe schema, so it runs parallel with the studio lane.

### Tasks

- [ ] T-004.1 — Recipe YAML loader + validation against `packages/shared/src/recipe.ts`, per-recipe failure isolation (skip invalid, serve the rest, report by name), in `packages/recond/src/registry/loader.ts`
- [ ] T-004.2 [P] — Versioned schema migrations: migrate older recipes in place, report every altered field, in `packages/recond/src/registry/migrations.ts`
- [ ] T-004.3 — RecipeRegistry: load every `enabled` recipe, register approved tools into the ToolSurface, load `enabled: false` recipes for doctor only, in `packages/recond/src/registry/registry.ts`
- [ ] T-004.4 — Directory watcher: reload a changed recipe within 5 seconds, retain the last valid version on failed reload, report the error without disturbing other recipes, in `packages/recond/src/registry/watcher.ts`
- [ ] T-004.5 [P] — Fixture load-time validation: expose fixture-invalid tools as degraded (never silently omitted), naming the failing fixture, in `packages/recond/src/registry/fixture-check.ts`
- [ ] T-004.6 — `GET /registry` route serving the current ToolSurface to runtime clients, in `packages/recond/src/routes/registry.ts`

### Verification

- [x] V-COV_RUN_001.1 — Three recipes on disk, one schema-invalid: the two valid recipes serve their tools; the failure is reported by recipe name (`e2e/daemon/registry.spec.ts`)
- [x] V-COV_RUN_001.2 — A recipe whose fixture no longer matches its schema exposes the tool marked degraded, naming the failing fixture (`e2e/daemon/registry.spec.ts`)
- [x] V-COV_RUN_002.1 — Editing a tool description in a recipe file is served by `GET /registry` within 5 seconds (`e2e/daemon/hot-reload.spec.ts`)
- [x] V-COV_RUN_002.2 — Writing invalid YAML over a loaded recipe keeps the previous tools serving and reports the error (`e2e/daemon/hot-reload.spec.ts`)

---

## WO-008 — Runtime clients: tool surface over CLI and MCP

Build order #5 — turns the registry into something Claude can call; the spike (T-008.1) is an M0 gate that must land before the rest of this WO.

### Tasks

- [ ] T-008.1 — **M0 spike (no deps, run first):** verify incur's MCP layer can re-register tools mid-session and emit `notifications/tools/list_changed`; if not, decide the thin-wrapper fallback that re-emits `tools/list` on reload; write findings + decision in `spike/incur-listchanged/README.md` (resolves Open Question Q1)
- [ ] T-008.2 — JSON Schema → Zod converter used at load time, in `packages/cli/src/schema-to-zod.ts`
- [ ] T-008.3 — ToolSurfaceBuilder: fetch surface from `GET /registry`, build incur command tree dynamically in a loop, `<recipe>_<tool>` MCP naming and `recon <recipe> <tool>` CLI naming, namespace keeps colliding tool names distinct without renaming, in `packages/cli/src/surface.ts`
- [ ] T-008.4 — `recon --mcp` stdio server: dynamic registration, `listChanged` emission when the surface changes and the client declared the capability, documented restart fallback otherwise, in `packages/cli/src/mcp.ts`
- [ ] T-008.5 [P] — RelayClient: argument validation, request-descriptor build, `POST /relay/:recipe/:tool` with install token, relay-failure → legible client error translation, in `packages/cli/src/relay-client.ts`
- [ ] T-008.6 [P] — Result shaping: apply Primary Payload Path unless `raw`, truncate >32 KB with truncation notice + untrimmed size, TOON default CLI output with `--format json|yaml|md`, in `packages/cli/src/shape.ts`

### Verification

- [x] V-COV_RUN_004.1 — Two recipes each defining `list`: `tools/list` returns both namespaced; CLI exposes each as `recon <recipe> list`; MCP JSON Schema matches the Zod schema the CLI validates against (`e2e/runtime/surface.spec.ts`)
- [x] V-COV_RUN_004.2 — With a `listChanged`-declaring MCP client connected, adding an approved tool on disk sends `notifications/tools/list_changed` and the next `tools/list` includes it (`e2e/runtime/surface.spec.ts`)
- [ ] V-COV_RUN_004.3 — A 40 KB response with a 1 KB Primary Payload Path returns the subtree; the same call with `raw` returns the full body; a >32 KB trimmed result states truncation and reports untrimmed size (`e2e/runtime/surface.spec.ts`)

---

## WO-001 — Capture extension: MAIN-world interception and session lifecycle

Build order #6 — the extension lane starts as soon as WO-003's WS endpoint exists; parallel with the studio and runtime lanes.

### Tasks

- [ ] T-001.1 — MV3 scaffold: `manifest.json` (permissions: `scripting`, `webRequest`, `storage`, `offscreen`, `notifications`, optional `debugger`; per-target host permissions at record time) + Vite build, in `packages/extension/manifest.json`, `packages/extension/vite.config.ts`
- [ ] T-001.2 — MAIN-world interceptor via `chrome.scripting.registerContentScripts({world: 'MAIN'})` wrapping `window.fetch` and `XMLHttpRequest`, capturing method, full URL, both header sets, both bodies, status; content-type/size only for non-UTF-8 or >2 MB bodies, in `packages/extension/src/interceptor.ts`
- [ ] T-001.3 — Content-script bridge relaying interceptor messages to the service worker, in `packages/extension/src/bridge.ts`
- [ ] T-001.4 — Service worker session lifecycle: start/stop, required non-empty session name, origin scoping to active tab + user allowlist, badge exchange count, retained-count report on stop, `chrome.storage` buffering, in `packages/extension/src/background.ts`
- [ ] T-001.5 [P] — `chrome.webRequest` completeness oracle: anything it sees that the interceptor missed is recorded headers-only and marked `body_missing`, in `packages/extension/src/oracle.ts`
- [ ] T-001.6 [P] — Noise filtering: bundled noise list (analytics, error reporting, session replay, ad, telemetry hosts), content-type allowlist (JSON, form-encoded, GraphQL, plain text), user-editable list applied to subsequent sessions with offered re-filter of existing sessions, in `packages/extension/src/noise.ts`
- [ ] T-001.7 — Redaction in the service worker before any exchange leaves the extension, reusing `packages/shared/src/redaction.ts`, in `packages/extension/src/redact.ts`
- [ ] T-001.8 — Popup UI: start/stop, session naming, live count, in `packages/extension/src/popup/`
- [ ] T-001.9 — WS client dialing `ws://127.0.0.1:<port>`, heartbeat-aware, backoff reconnect, exchange delivery, in `packages/extension/src/ws-client.ts`

### Verification

- [x] V-COV_CAP_001.1 — Session "orders" on the fixture SPA: POST create + GET list show badge 2; recond receives 2 exchanges with non-empty request and response bodies (`e2e/capture/session-capture.spec.ts`)
- [x] V-COV_CAP_001.2 — A third-party analytics request and a CSS asset request are both absent from the persisted session (`e2e/capture/session-capture.spec.ts`)
- [x] V-COV_CAP_001.3 — An `authorization` header and a body `password` field persist as placeholders; the original values appear nowhere on disk (`e2e/capture/session-capture.spec.ts`)

---

## WO-009 — Relay execution

Build order #7 — joins the extension (WO-001) and runtime (WO-008) lanes; this is what makes tools work against real logins.

### Tasks

- [ ] T-009.1 — `POST /relay/:recipe/:tool` route: accept request descriptor + install token, never issue the target request from the daemon, in `packages/recond/src/routes/relay.ts`
- [ ] T-009.2 — RelayBridge: forward descriptors over the extension WS, correlate requests to responses, timeouts under the MV3 5-minute cap, return status/headers/body for shaping, in `packages/recond/src/relay/bridge.ts`
- [ ] T-009.3 — Call guards enforced in recond before any forward: per-tool rate limit with queue (not drop), `destructive` rejection without `confirm`, degraded rejection naming the detected change, in `packages/recond/src/relay/guards.ts`
- [ ] T-009.4 [P] — Redacted audit log (tool name, parameters, status, duration) appended on every invocation, in `packages/recond/src/relay/audit.ts`
- [ ] T-009.5 [P] — Failure classification: 401/403/login-redirect → `session_expired`, no retry; relay-unavailable states, in `packages/recond/src/relay/classify.ts`
- [ ] T-009.6 — Extension relay handler: issue same-origin `fetch` with `credentials: 'include'` from an Executor Tab; create an offscreen tab on the target origin when none exists, in `packages/extension/src/relay-handler.ts` + `packages/extension/src/executor-tab.ts`
- [ ] T-009.7 — Page-state credential reads per the recipe's auth descriptor (read from page context exactly as the app does, attach to the relayed request, never persist), in `packages/extension/src/page-credential.ts`
- [ ] T-009.8 [P] — Expired-session browser notification linking to the target's login page when an open Executor Tab detects expiry, in `packages/extension/src/session-notify.ts`

### Verification

- [ ] V-COV_EXE_001.1 — Signed in to the fixture app, a read tool call carries the session cookie to the fixture server and returns the trimmed payload (`e2e/relay/execution.spec.ts`)
- [ ] V-COV_EXE_001.2 — With a page-state bearer token + CSRF header recipe, the fixture server receives both values and neither is persisted anywhere (`e2e/relay/execution.spec.ts`)
- [ ] V-COV_EXE_002.1 — After server-side session invalidation, the call is classified `session_expired` and the fixture server recorded exactly one request (`e2e/relay/session-expiry.spec.ts`)
- [x] V-COV_EXE_003.1 — `delete_order` without `confirm` is rejected with zero requests recorded by the fixture server (`e2e/relay/guards.spec.ts`)
- [x] V-COV_EXE_003.2 — A recipe-degraded tool returns a structured error naming the tool and detected change, with zero requests recorded (`e2e/relay/guards.spec.ts`)

---

## WO-007 — Review UI and recipe merge

Build order #8 — closes the studio lane into approved recipes; needs WO-005/006 output and writes what WO-004 loads; parallel with WO-009.

### Tasks

- [ ] T-007.1 — Studio server: Hono-served SPA on loopback + `recon studio` launch command, in `packages/studio/src/server.ts` + `packages/cli/src/commands/studio.ts`
- [ ] T-007.2 — Review SPA: candidate list with name, description, side-effect label, confidence, observation count, annotation, UI provenance, redacted sample exchange, in `packages/studio/app/`
- [ ] T-007.3 — Edit API: inline edits to name/description/schema written to the recipe and marked `user_edited`, in `packages/studio/src/api.ts`
- [ ] T-007.4 — Promotion: bulk approve restricted to `read` candidates, individual approval required for `write`/`destructive`, required `confirm` parameter injected on destructive approval, unapproved candidates never exposed, in `packages/studio/src/promotion.ts`
- [ ] T-007.5 — Merge engine for re-inference: keep `user_edited` values and store inferred alternatives as suggestions, retain absent tools marked `unverified` with last-observed date, report fixture-invalidating schema conflicts without overwriting until resolved, in `packages/studio/src/merge.ts`
- [ ] T-007.6 [P] — Fixture writer: store ≥1 redacted fixture per approved tool, re-run redaction on write and fail if any credential-shaped value survives, in `packages/studio/src/fixtures.ts`

### Verification

- [ ] V-COV_REC_002.1 — "Approve all reads" on a mixed session approves only read candidates (`e2e/studio/review.spec.ts`)
- [ ] V-COV_REC_002.2 — Individually approving `delete_order` writes a required `confirm` parameter into the recipe entry (`e2e/studio/review.spec.ts`)
- [ ] V-COV_REC_002.3 — With recond running and a client connected, a saved description edit reaches the client's tool list within 30 seconds, no client restart (`e2e/studio/review.spec.ts`)
- [ ] V-COV_REC_003.1 — After edit + re-record + re-inference, the edited description is unchanged and the inferred one is stored as a suggestion (`e2e/studio/recipe-merge.spec.ts`)
- [ ] V-COV_REC_003.2 — Re-inference from a session missing an approved tool retains it, marked `unverified` with a last-observed date (`e2e/studio/recipe-merge.spec.ts`)

---

## WO-010 — Connector installation

Build order #9 — completes the M1 end-to-end demo: bundle install, `mcp add`, legible chat-window failures.

### Tasks

- [ ] T-010.1 — `recon bundle`: emit `.mcpb` zip with `manifest.json` (`user_config` form fields for relay URL + install token) and the MCP server entry point, using Claude Desktop's bundled Node on macOS/Windows, in `packages/cli/src/commands/bundle.ts` + `packages/cli/mcpb/manifest.json`
- [ ] T-010.2 [P] — `recon mcp add --agent claude-code`: write a stdio entry invoking `recon --mcp`, report the scope written, reject reserved names (`workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview`, `Claude Browser`) by suffixing, in `packages/cli/src/commands/mcp-add.ts`
- [ ] T-010.3 [P] — `recon skills add`: install skill files describing enabled recipes' tools with worked examples drawn from fixtures, in `packages/cli/src/commands/skills.ts`
- [ ] T-010.4 — Long-call survival: MCP progress notification at 60 s and every 60 s thereafter; configured ceiling cancels with a structured timeout naming tool + elapsed time, in `packages/cli/src/mcp.ts` (extends T-008.4/T-008.5)
- [ ] T-010.5 — The four client-facing error states (relay not running + how to start; extension disconnected naming target; session expired naming target + sign-in instruction; never retry, never headless-fallback), in `packages/cli/src/errors.ts`

### Verification

- [ ] V-COV_CON_001.1 — `recon bundle` → install `.mcpb` in a scratch Claude Desktop profile → settings form completed → server starts and `tools/list` returns the enabled recipes' tools (`e2e/connector/desktop.spec.ts`)
- [ ] V-COV_CON_001.2 — Approving a tool in a new recipe makes it callable with no reinstall and no bundle rebuild (`e2e/connector/desktop.spec.ts`)
- [ ] V-COV_CON_002.1 — `recon mcp add --agent claude-code` against a scratch config writes a stdio entry invoking `recon --mcp`, the reported scope matches the changed file, `claude mcp list` reports connected (`e2e/connector/claude-code.spec.ts`)
- [ ] V-COV_CON_002.2 — Registration under `workspace` is suffixed and succeeds (`e2e/connector/claude-code.spec.ts`)
- [ ] V-COV_CON_004.1 — recond stopped / extension disabled / session invalidated each produce their specified error text; no case retried or fell back to headless (`e2e/connector/failures.spec.ts`)
- [ ] V-COV_CON_003.1 — A 7-minute-delayed read over MCP emits progress notifications at least once per minute and completes successfully (`e2e/connector/failures.spec.ts`)

---

## WO-002 — Capture extension: provenance, annotation, debugger fallback

Build order #10 — enriches description quality (M1 scope) but the golden-path demo doesn't block on it; can run parallel with WO-009/010 in the extension lane.

### Tasks

- [ ] T-002.1 — Gesture tracker content script: accessible name + role of the last activated interactive element, document title + route path, in `packages/extension/src/provenance.ts`
- [ ] T-002.2 — Attribution in the service worker: 2-second window, `background` marking with no stale provenance for gesture-less requests, in `packages/extension/src/background.ts` (extends T-001.4)
- [ ] T-002.3 — In-popup annotation: free-text note attached to every exchange since the previous note, persisted as an Annotation Span with start/end positions in the CaptureStore, in `packages/extension/src/popup/` + `packages/recond/src/capture-store.ts`
- [ ] T-002.4 — Span-to-candidate propagation in inference: note attached to each candidate its span covers, prioritized over provenance for description generation, never required, in `packages/studio/src/inference/engine.ts` (extends T-005.7)
- [ ] T-002.5 [P] — Per-session `chrome.debugger` opt-in: attach/detach, `Network.getResponseBody`, service-worker traffic capture, in `packages/extension/src/debugger-capture.ts`
- [ ] T-002.6 — Dual-path reconciliation: an exchange captured by both interceptor and debugger is emitted at most once, in `packages/extension/src/dedupe.ts`

### Verification

- [ ] V-COV_CAP_003.1 — Clicking "Create order" attaches provenance with accessible name "Create order" and the current route to the exchange (`e2e/capture/provenance.spec.ts`)
- [ ] V-COV_CAP_003.2 — 5 seconds of polling with no interaction: every captured exchange is `background` with no provenance (`e2e/capture/provenance.spec.ts`)
- [ ] V-COV_CAP_007.1 — A note attached between requests 2 and 3 lands on the candidate from exchange 3 and not the earlier candidates (`e2e/capture/annotation.spec.ts`)
- [ ] V-COV_CAP_007.2 — An unannotated session still produces candidates; none is blocked on a missing annotation (`e2e/capture/annotation.spec.ts`)

---

## WO-011 — Drift detection

Build order #11 — M2; needs the registry write path (WO-004) and replay through the relay (WO-009).

### Tasks

- [x] T-011.1 — DriftWatcher scheduler: configured interval, silent skip when the browser relay is unavailable, in `packages/recond/src/drift/watcher.ts`
- [x] T-011.2 — Fixture replay: `read` fixtures only — never `write` or `destructive` — through the relay, in `packages/recond/src/drift/replay.ts`
- [x] T-011.3 — Five-way classification per tool: `ok` | `schema_widened` | `breaking` | `session_expired` | `gone`, in `packages/recond/src/drift/classify.ts`
- [ ] T-011.4 — Degradation write-back into the recipe (propagates via hot reload; healthy tools in the same recipe unaffected), in `packages/recond/src/drift/degrade.ts`
- [ ] T-011.5 [P] — Patch proposals: `schema_widened` → proposed recipe patch adding new optional fields, existing fields untouched; offer git branch commit when the recipe is in a repo, in `packages/recond/src/drift/patch.ts`
- [ ] T-011.6 [P] — Webhook notification on any `breaking` or `gone` result, in `packages/recond/src/drift/notify.ts`
- [ ] T-011.7 — `recon doctor [recipe]` on-demand command, in `packages/cli/src/commands/doctor.ts`

### Verification

- [ ] V-COV_DRF_001.1 — `recon doctor` on a recipe with read/write/destructive tools: the fixture server received requests only for read tools (`e2e/drift/doctor.spec.ts`)
- [ ] V-COV_DRF_001.2 — An added optional response field classifies `schema_widened` with a patch adding it as optional and no other change (`e2e/drift/doctor.spec.ts`)
- [ ] V-COV_DRF_002.1 — Removing a required response field: recipe updated, running client reflects degradation without restart, affected tool fails before issuing a request, unaffected tool still succeeds (`e2e/drift/degradation.spec.ts`)

---

## WO-012 — Eject to a standalone package

Build order #12 — M3; needs approved recipes (WO-007) and the runtime execution semantics to match (WO-008); parallel with WO-013.

### Tasks

- [ ] T-012.1 — PackageEjector: emit a TypeScript incur package with one command per approved tool (path + required params → `args`, optional → `options`), `output` schema from the response contract, ≥1 `examples` entry from a fixture, in `packages/studio/src/eject/emitter.ts`
- [ ] T-012.2 [P] — Emission templates: `incur` as the only runtime dependency, no Recon imports, per-file header naming source recipe + version, in `packages/studio/src/eject/templates/`
- [ ] T-012.3 — Determinism: byte-identical output for repeated ejects of the same recipe (sorted keys, no timestamps), in `packages/studio/src/eject/emitter.ts`
- [ ] T-012.4 — Ejected execution: relay-first when recond is reachable, headless fallback with degraded-path notice when configured, fixture-replay tests failing non-zero naming each failing tool, in `packages/studio/src/eject/templates/`
- [ ] T-012.5 — `recon eject <recipe> --out <dir>` command, in `packages/cli/src/commands/eject.ts`

### Verification

- [ ] V-COV_EJT_001.1 — Two ejects are byte-identical; `package.json` declares `incur` as the only runtime dependency with no Recon import; a built read command's output matches the interpreted runtime for the same arguments (`e2e/eject/package.spec.ts`)
- [ ] V-COV_EJT_001.2 — A fixture altered to contradict its schema makes the emitted tests exit non-zero naming the failing tool (`e2e/eject/package.spec.ts`)

---

## WO-013 — Headless mode

Build order #13 — M3; the explicitly degraded cron path, needing only the relay substrate (WO-009); parallel with WO-012.

### Tasks

- [x] T-013.1 — Session export into the OS keychain on explicit per-target opt-in, with only a reference in configuration (never a session value), in `packages/recond/src/headless/keychain.ts` + `packages/recond/src/headless/config.ts`
- [x] T-013.2 — Direct execution from recond: recipe-declared refresh endpoint applied on 401 with a single retry, in `packages/recond/src/headless/executor.ts`
- [x] T-013.3 — Mandatory degraded-path notice on every headless invocation; on refresh failure, clear the keychain entry and report that browser relay is required, in `packages/recond/src/headless/executor.ts`
- [ ] T-013.4 [P] — `recon headless enable|disable <target>` commands, in `packages/cli/src/commands/headless.ts`

### Verification

- [ ] V-COV_EXE_004.1 — With headless enabled and the browser closed, a read tool succeeds with a degraded-path notice; config holds a keychain reference and no session value (`e2e/relay/headless.spec.ts`)
- [ ] V-COV_EXE_004.2 — With the stored session and refresh endpoint invalidated, the call exits non-zero, requires browser relay, and the keychain entry is empty (`e2e/relay/headless.spec.ts`)

---

## Open Questions (PRD 5.3 — resolve during implementation)

- [x] Q1 — **RESOLVED (verified)**: incur's `Mcp.serve()` does NOT support mid-session re-registration — `collectTools` snapshots once at connect. The escape hatch works and was executed end-to-end: `Cli.toCommands` (live Map) + `Mcp.collectTools` + `Mcp.callTool` + own `McpServer`, whose `registerTool()` handle fires `notifications/tools/list_changed` automatically. Original question: Does incur support re-registering tools mid-session and emitting `listChanged`? Spike in M0 (T-008.1). Fallback: a thin wrapper that re-emits `tools/list` on reload.
- [ ] Q2 — How does Claude Desktop behave with a wide tool surface? Claude Code's tool search absorbs it; Desktop is unverified. Fallback: the `enabled` flag; next step, named profiles (ADR-007).
- [ ] Q3 — Is a local model good enough to hold the 90% selection-accuracy bar, given description generation conflicts with local-first otherwise? Measure with the eval harness (T-006.4) against a local endpoint.
- [ ] Q4 — Is relay latency acceptable for agent loops making many sequential calls? The 150 ms target is a guess until WO-009 measures it. Fallback: relay-call batching.
- [ ] Q5 — Does MAIN-world interception hold up on real targets, or do CSP and page hardening push sessions onto the debugger path? Test three real targets before WO-001 locks the strategy. Fallback: the `chrome.debugger` opt-in path (ADR-002).
- [ ] Q6 — Should recipes be portable between machines given environment-specific fixtures and base URLs? Leaning: per-target config overlays rather than environment-aware recipes.

---

## Cleanup & Review

- [ ] C-1 — Live verification: record a session against https://dashboard.openfort.io/ in Helium, infer, review, approve, and complete a real read action from Claude Desktop and the CLI (Part 0 exit criterion, M1)
- [ ] C-2 — Second-recipe check: add another recipe after C-1 and confirm its tools appear in Claude Desktop with zero reinstalls or reconnects (AC-CON-001.4)
- [ ] C-3 — Success-metric pass: measure record-to-callable time (<15 min), relay overhead (<150 ms median), trimmed result size (<2 KB median), fixture replay pass rate (≥95%) against PRD 1.5
- [ ] C-4 — Security sweep: grep the recipe dir, fixtures, SQLite DB, logs, and ejected output for credential-shaped values (TR-6); confirm redaction invariants hold at every persistence boundary
- [ ] C-5 — Zero-warnings pass: `oxlint`, `tsc --noEmit`, `vitest`, Playwright suite all clean across the workspace
- [ ] C-6 — Dead-code and simplification review: remove unused exports, collapse speculative abstractions, verify each package's boundary matches the blueprints (recond stays small per TR-5)
- [ ] C-7 — Docs: README covering the golden path verbatim from PRD 5.2, recipe format reference, and the documented `listChanged` restart limitation (AC-RUN-002.4)
