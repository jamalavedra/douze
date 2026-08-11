# Douze — Implementation Task Tracker

Douze watches you use an authenticated dashboard for five minutes and turns the traffic into tools any MCP client — Claude Desktop, Claude Code, Cursor, VS Code, Windsurf — and the shell can call. Tool calls execute inside your signed-in browser via a relay, so no credential is ever extracted or stored. Recipes are versioned YAML interpreted at runtime, so a new target or an edited description reaches a running client in seconds with zero re-registration.

> **File paths in the task list below are the layout this work was *planned* against.** Implementation
> consolidated many of them (no `src/registry/`, `src/relay/`, `src/drift/` directories; one
> `server.ts` in douzed; the review SPA is `packages/studio/src/app.ts` served by douzed). The
> shipped layout is the package map in `README.md`; do not treat a path here as a file that exists.

```
  Chrome ext ──ws──▶ douzed ◀──http/loopback──┬── douze --mcp   (stdio, launched by any MCP client)
                     │                        └── douze jira create-issue   (shell)
                     └── review UI ──▶ recipes/*.yaml ──▶ douzed
```

Consumer path — no terminal:

```
  load packages/extension/dist unpacked in chrome://extensions   # once, ever
  double-click Douze.mcpb                                        # once, ever — Claude Desktop
  douze mcp add --agent cursor|vscode|claude-code|windsurf       # once, ever — any other client

  # click Watch this site, do the workflow, click Done
  # the extension links to the daemon's review UI; approve there
  # → tools are live in Claude Desktop within seconds; no reinstall
```

Developer commands:

```
  pnpm bundle                                  # build + emit ./Douze.mcpb
  douze mcp add --agent claude-code            # once, ever — any MCP client
  douze start | stop | status                  # the daemon, which otherwise runs inside `--mcp`
  douze doctor jira                            # later: has the target drifted?
  douze eject jira --out ./jira-tools          # optional: an artifact you own
```

**Progress: 142/147 tasks complete** (86 implementation, 48 verification)

Monorepo: pnpm workspaces, TypeScript, Node 22 / Bun. Packages: `packages/shared`, `packages/extension`, `packages/douzed`, `packages/studio`, `packages/cli`. Runtime built on the `incur` npm package (wevm): Zod schemas drive the CLI, `--mcp` exposes the same commands as MCP tools. E2E: Playwright driving Helium (`/Applications/Helium.app`) with the unpacked MV3 extension, against a local fixture SPA + fixture server in `e2e/fixtures/`.

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

## WO-003 — douzed foundation: relay daemon, capture store, control CLI, HAR import

Build order #1 — everything depends on this substrate (shared types, daemon, storage, e2e harness), and HAR import unblocks the whole studio lane before the extension exists.

### Tasks

- [x] T-003.1 — Scaffold pnpm workspace: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` (strict flags per global standards), `.oxlintrc.json`, vitest workspace config
- [x] T-003.2 — Recipe schema: TypeScript types + Zod schema for the `Recipe` model (version, name, enabled, target.base_url, auth.mode, auth.credential_source descriptor, tools[] with name/description/side_effect/confidence/observations/request/response/fixtures/flags) in `packages/shared/src/recipe.ts`
- [x] T-003.3 [P] — Capture types: `CaptureSession`, `Exchange` (headers, bodies, timing, provenance, `body_missing`/`background` flags), `AnnotationSpan` in `packages/shared/src/capture.ts`
- [x] T-003.4 [P] — Redaction module: credential-header list (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-csrf-token`, user additions), secret-field list (`password`, `token`, `secret`, `apiKey`, `refresh_token`, user additions), stable placeholders preserving type + length, in `packages/shared/src/redaction.ts`
- [x] T-003.5 [P] — WS protocol types: `exchange.*` (extension→daemon) and `relay.*` (daemon→extension) message families in `packages/shared/src/protocol.ts`
- [x] T-003.6 — Daemon process + lifecycle: entry point, PID/port file, single-instance detection with exit-and-message on second start, in `packages/douzed/src/daemon.ts`
- [x] T-003.7 — Hono app on loopback with per-install token middleware (token generated on first run, stored in config dir) in `packages/douzed/src/http.ts`
- [x] T-003.8 — Extension WebSocket endpoint: accept `ws://127.0.0.1:<port>`, heartbeat inside the 30-second MV3 idle window, connection-state tracking, in `packages/douzed/src/ws.ts`
- [x] T-003.9 — CaptureStore on SQLite: persist sessions/exchanges/annotation spans, enforce redaction invariant before write (reject any exchange with credential-shaped values), serve exchange queries, in `packages/douzed/src/capture-store.ts`
- [x] T-003.10 — CLI scaffold on incur: `douze start|stop|status|sessions` commands in `packages/cli/src/index.ts` + `packages/cli/src/commands/daemon.ts`
- [x] T-003.11 — Daemon client with auto-start: detect douzed down, spawn it, wait for reachability, proceed; recovery after daemon restart, in `packages/cli/src/daemon-client.ts`
- [x] T-003.12 — HAR import: convert HAR entries to a Capture Session applying live-capture noise filtering + redaction, mark body-less entries `body_missing`, `douze import <file> --name <n>`, in `packages/douzed/src/har-import.ts` + `packages/cli/src/commands/import.ts`
- [x] T-003.13 [P] — E2E harness: Playwright config launching Helium (`/Applications/Helium.app`) with the unpacked extension, fixture SPA (orders app with auth, analytics beacon, CSS asset, GraphQL endpoint, polling mode, page-state-token mode, delay mode), fixture server recording every request it receives, in `e2e/playwright.config.ts`, `e2e/fixtures/spa/`, `e2e/fixtures/server.ts`, plus `fixtures/orders.har`

### Verification

- [x] V-COV_RUN_003.1 — Starting a second `douzed` exits non-zero with a message naming the running instance; only one port bound (`e2e/daemon/lifecycle.spec.ts`)
- [x] V-COV_RUN_003.2 — With douzed stopped, a CLI command auto-starts it and completes; after killing douzed, the next command recovers with no user action (`e2e/daemon/lifecycle.spec.ts`)
- [x] V-COV_CAP_006.1 — `douze import fixtures/orders.har --name orders-har` yields a session with only JSON exchanges from the primary origin and `authorization` values as placeholders (`e2e/daemon/har-import.spec.ts`)
- [x] V-COV_CAP_006.2 — Importing a HAR whose entries lack response content marks every exchange `body_missing` and discards none (`e2e/daemon/har-import.spec.ts`)

---

## WO-005 — Inference engine

Build order #2 — M0's first kill-question feeds from HAR sessions, no extension needed; runs parallel with WO-004.

### Tasks

- [x] T-005.1 — Endpoint templating: collapse same-method exchanges differing in one path segment into `EndpointTemplate` with named parameter (from response `id`-like field, else singular preceding static segment), in `packages/studio/src/inference/templating.ts`
- [x] T-005.2 [P] — Schema inference: required iff present in every observation, open enums for <12 distinct string values over ≥3 observations, `sparse` + confidence ≤0.4 for single-observation tools, emit JSON Schema convertible to Zod without manual editing, in `packages/studio/src/inference/schema.ts`
- [x] T-005.3 [P] — GraphQL splitting: group by operation name, one candidate per operation, input schema from observed `variables`, store operation document, derive names for anonymous ops (marked `derived_name`), exclude 200-with-`errors` exchanges from schema inference, in `packages/studio/src/inference/graphql.ts`
- [x] T-005.4 [P] — Side-effect classification: GET/HEAD → `read`, POST/PUT/PATCH/DELETE → `write`, destructive-pattern match (`delete`, `remove`, `purge`, `cancel`, `refund`, `revoke`) → `destructive`, in `packages/studio/src/inference/side-effects.ts`
- [x] T-005.5 [P] — Primary Payload Path selection + pagination detection (page/cursor params, recorded pagination style) in `packages/studio/src/inference/payload.ts`
- [x] T-005.6 [P] — Confidence scoring from observation count, schema stability, side-effect certainty, in `packages/studio/src/inference/confidence.ts`
- [x] T-005.7 — Engine orchestrator: exchanges → scored `CandidateTool` records, every candidate traceable to ≥1 exchange, deterministic and replayable with no model calls, in `packages/studio/src/inference/engine.ts`

### Verification

- [x] V-COV_INF_001.1 — GETs to `/orders/1042|1043|1044` collapse to exactly one candidate with path `/orders/{orderId}`, parameter named from the response `id` field (`e2e/studio/inference.spec.ts`)
- [x] V-COV_INF_001.2 — Three POSTs where `note` appears once yield `note` optional and always-present fields required (`e2e/studio/inference.spec.ts`)
- [x] V-COV_INF_004.1 — `/graphql` session with `GetIssue`, `CreateIssue`, `GetIssue` yields two candidates with variables-derived schemas (`e2e/studio/graphql-inference.spec.ts`)
- [x] V-COV_INF_004.2 — A `CreateIssue` returning HTTP 200 with populated `errors` did not contribute to the response contract (`e2e/studio/graphql-inference.spec.ts`)

---

## WO-006 — Naming and description generation

Build order #3 — M0's 90% selection-accuracy exit criterion lives here; needs WO-005 candidates.

### Tasks

- [x] T-006.1 — Naming: verb-object snake_case from method/path/annotation/provenance, within-recipe collision disambiguation from distinguishing parameters, in `packages/studio/src/descriptions/naming.ts`
- [x] T-006.2 — Model client: configurable endpoint with local-model override taking precedence over remote provider, in `packages/studio/src/descriptions/model-client.ts`
- [x] T-006.3 — DescriptionWriter: ≤3-sentence what/returns/when descriptions, Annotation Span notes prioritized over UI provenance, redaction assertion on every model input payload (fail closed if a credential-shaped value is present), in `packages/studio/src/descriptions/writer.ts`
- [x] T-006.4 [P] — Offline eval harness scoring tool-selection accuracy against a labeled natural-language task set for the reference recipe, in `packages/studio/eval/selection.ts` + `packages/studio/eval/tasks/reference.yaml`

### Verification

- [x] V-COV_INF_006.1 — Candidate with span note "transitions an issue to done" and provenance "Save" gets a description reflecting the transition intent, not the button label (`e2e/studio/descriptions.spec.ts`)
- [x] V-COV_INF_006.2 — With a recording mock model endpoint, no request to it contains the original credential value from the session (`e2e/studio/descriptions.spec.ts`)
- [x] V-COV_INF_006.3 — Eval harness over the labeled task set reports selection accuracy ≥90% (`e2e/studio/descriptions.spec.ts`)

---

## WO-004 — Recipe registry and hot reload

Build order #4 — the install-once mechanism; needs only WO-003 + shared recipe schema, so it runs parallel with the studio lane.

### Tasks

- [x] T-004.1 — Recipe YAML loader + validation against `packages/shared/src/recipe.ts`, per-recipe failure isolation (skip invalid, serve the rest, report by name), in `packages/douzed/src/registry/loader.ts`
- [x] T-004.2 [P] — Versioned schema migrations: migrate older recipes in place, report every altered field, in `packages/douzed/src/registry/migrations.ts`
- [x] T-004.3 — RecipeRegistry: load every `enabled` recipe, register approved tools into the ToolSurface, load `enabled: false` recipes for doctor only, in `packages/douzed/src/registry/registry.ts`
- [x] T-004.4 — Directory watcher: reload a changed recipe within 5 seconds, retain the last valid version on failed reload, report the error without disturbing other recipes, in `packages/douzed/src/registry/watcher.ts`
- [x] T-004.5 [P] — Fixture load-time validation: expose fixture-invalid tools as degraded (never silently omitted), naming the failing fixture, in `packages/douzed/src/registry/fixture-check.ts`
- [x] T-004.6 — `GET /registry` route serving the current ToolSurface to runtime clients, in `packages/douzed/src/routes/registry.ts`

### Verification

- [x] V-COV_RUN_001.1 — Three recipes on disk, one schema-invalid: the two valid recipes serve their tools; the failure is reported by recipe name (`e2e/daemon/registry.spec.ts`)
- [x] V-COV_RUN_001.2 — A recipe whose fixture no longer matches its schema exposes the tool marked degraded, naming the failing fixture (`e2e/daemon/registry.spec.ts`)
- [x] V-COV_RUN_002.1 — Editing a tool description in a recipe file is served by `GET /registry` within 5 seconds (`e2e/daemon/hot-reload.spec.ts`)
- [x] V-COV_RUN_002.2 — Writing invalid YAML over a loaded recipe keeps the previous tools serving and reports the error (`e2e/daemon/hot-reload.spec.ts`)

---

## WO-008 — Runtime clients: tool surface over CLI and MCP

Build order #5 — turns the registry into something Claude can call; the spike (T-008.1) is an M0 gate that must land before the rest of this WO.

### Tasks

- [x] T-008.1 — **M0 spike (no deps, run first):** verify incur's MCP layer can re-register tools mid-session and emit `notifications/tools/list_changed`; if not, decide the thin-wrapper fallback that re-emits `tools/list` on reload; write findings + decision in `spike/incur-listchanged/README.md` (resolves Open Question Q1)
- [x] T-008.2 — JSON Schema → Zod converter used at load time, in `packages/cli/src/schema-to-zod.ts`
- [x] T-008.3 — ToolSurfaceBuilder: fetch surface from `GET /registry`, build incur command tree dynamically in a loop, `<recipe>_<tool>` MCP naming and `douze <recipe> <tool>` CLI naming, namespace keeps colliding tool names distinct without renaming, in `packages/cli/src/surface.ts`
- [x] T-008.4 — `douze --mcp` stdio server: dynamic registration, `listChanged` emission when the surface changes and the client declared the capability, documented restart fallback otherwise, in `packages/cli/src/mcp.ts`
- [x] T-008.5 [P] — RelayClient: argument validation, request-descriptor build, `POST /relay/:recipe/:tool` with install token, relay-failure → legible client error translation, in `packages/cli/src/relay-client.ts`
- [x] T-008.6 [P] — Result shaping: apply Primary Payload Path unless `raw`, truncate >32 KB with truncation notice + untrimmed size, TOON default CLI output with `--format json|yaml|md`, in `packages/cli/src/shape.ts`

### Verification

- [x] V-COV_RUN_004.1 — Two recipes each defining `list`: `tools/list` returns both namespaced; CLI exposes each as `douze <recipe> list`; MCP JSON Schema matches the Zod schema the CLI validates against (`e2e/runtime/surface.spec.ts`)
- [x] V-COV_RUN_004.2 — With a `listChanged`-declaring MCP client connected, adding an approved tool on disk sends `notifications/tools/list_changed` and the next `tools/list` includes it (`e2e/runtime/surface.spec.ts`)
- [x] V-COV_RUN_004.3 — A 40 KB response with a 1 KB Primary Payload Path returns the subtree; the same call with `raw` returns the full body; a >32 KB trimmed result states truncation and reports untrimmed size (`e2e/runtime/surface.spec.ts`)

---

## WO-001 — Capture extension: MAIN-world interception and session lifecycle

Build order #6 — the extension lane starts as soon as WO-003's WS endpoint exists; parallel with the studio and runtime lanes.

### Tasks

- [x] T-001.1 — MV3 scaffold: `manifest.json` (permissions: `scripting`, `webRequest`, `storage`, `offscreen`, `notifications`, optional `debugger`; per-target host permissions at record time) + Vite build, in `packages/extension/manifest.json`, `packages/extension/vite.config.ts`
- [x] T-001.2 — MAIN-world interceptor via `chrome.scripting.registerContentScripts({world: 'MAIN'})` wrapping `window.fetch` and `XMLHttpRequest`, capturing method, full URL, both header sets, both bodies, status; content-type/size only for non-UTF-8 or >2 MB bodies, in `packages/extension/src/interceptor.ts`
- [x] T-001.3 — Content-script bridge relaying interceptor messages to the service worker, in `packages/extension/src/bridge.ts`
- [x] T-001.4 — Service worker session lifecycle: start/stop, required non-empty session name, origin scoping to active tab + user allowlist, badge exchange count, retained-count report on stop, `chrome.storage` buffering, in `packages/extension/src/background.ts`
- [x] T-001.5 [P] — `chrome.webRequest` completeness oracle: anything it sees that the interceptor missed is recorded headers-only and marked `body_missing`, in `packages/extension/src/oracle.ts`
- [x] T-001.6 [P] — Noise filtering: bundled noise list (analytics, error reporting, session replay, ad, telemetry hosts), content-type allowlist (JSON, form-encoded, GraphQL, plain text), user-editable list applied to subsequent sessions with offered re-filter of existing sessions, in `packages/extension/src/noise.ts`
- [x] T-001.7 — Redaction in the service worker before any exchange leaves the extension, reusing `packages/shared/src/redaction.ts`, in `packages/extension/src/redact.ts`
- [x] T-001.8 — Popup UI: start/stop, session naming, live count, in `packages/extension/src/popup/`
- [x] T-001.9 — WS client dialing `ws://127.0.0.1:<port>`, heartbeat-aware, backoff reconnect, exchange delivery, in `packages/extension/src/ws-client.ts`

### Verification

- [x] V-COV_CAP_001.1 — Session "orders" on the fixture SPA: POST create + GET list show badge 2; douzed receives 2 exchanges with non-empty request and response bodies (`e2e/capture/session-capture.spec.ts`)
- [x] V-COV_CAP_001.2 — A third-party analytics request and a CSS asset request are both absent from the persisted session (`e2e/capture/session-capture.spec.ts`)
- [x] V-COV_CAP_001.3 — An `authorization` header and a body `password` field persist as placeholders; the original values appear nowhere on disk (`e2e/capture/session-capture.spec.ts`)

---

## WO-009 — Relay execution

Build order #7 — joins the extension (WO-001) and runtime (WO-008) lanes; this is what makes tools work against real logins.

### Tasks

- [x] T-009.1 — `POST /relay/:recipe/:tool` route: accept request descriptor + install token, never issue the target request from the daemon, in `packages/douzed/src/routes/relay.ts`
- [x] T-009.2 — RelayBridge: forward descriptors over the extension WS, correlate requests to responses, timeouts under the MV3 5-minute cap, return status/headers/body for shaping, in `packages/douzed/src/relay/bridge.ts`
- [x] T-009.3 — Call guards enforced in douzed before any forward: per-tool rate limit with queue (not drop), `destructive` rejection without `confirm`, degraded rejection naming the detected change, in `packages/douzed/src/relay/guards.ts`
- [x] T-009.4 [P] — Redacted audit log (tool name, parameters, status, duration) appended on every invocation, in `packages/douzed/src/relay/audit.ts`
- [x] T-009.5 [P] — Failure classification: 401/403/login-redirect → `session_expired`, no retry; relay-unavailable states, in `packages/douzed/src/relay/classify.ts`
- [x] T-009.6 — Extension relay handler: issue same-origin `fetch` with `credentials: 'include'` from an Executor Tab; create an offscreen tab on the target origin when none exists, in `packages/extension/src/relay-handler.ts` + `packages/extension/src/executor-tab.ts`
- [x] T-009.7 — Page-state credential reads per the recipe's auth descriptor (read from page context exactly as the app does, attach to the relayed request, never persist), in `packages/extension/src/page-credential.ts`
- [x] T-009.8 [P] — Expired-session browser notification linking to the target's login page when an open Executor Tab detects expiry, in `packages/extension/src/session-notify.ts`

### Verification

- [x] V-COV_EXE_001.1 — Signed in to the fixture app, a read tool call carries the session cookie to the fixture server and returns the trimmed payload (`e2e/relay/execution.spec.ts`)
- [x] V-COV_EXE_001.2 — With a page-state bearer token + CSRF header recipe, the fixture server receives both values and neither is persisted anywhere (`e2e/relay/execution.spec.ts`)
- [x] V-COV_EXE_002.1 — After server-side session invalidation, the call is classified `session_expired` and the fixture server recorded exactly one request (`e2e/relay/session-expiry.spec.ts`)
- [x] V-COV_EXE_003.1 — `delete_order` without `confirm` is rejected with zero requests recorded by the fixture server (`e2e/relay/guards.spec.ts`)
- [x] V-COV_EXE_003.2 — A recipe-degraded tool returns a structured error naming the tool and detected change, with zero requests recorded (`e2e/relay/guards.spec.ts`)

---

## WO-007 — Review UI and recipe merge

Build order #8 — closes the studio lane into approved recipes; needs WO-005/006 output and writes what WO-004 loads; parallel with WO-009.

### Tasks

- [x] T-007.1 — Review UI on loopback. **Shipped differently:** there is no studio server and no `douze studio` command. douzed serves the review page itself (`/review/:sessionId` in `packages/douzed/src/server.ts`, loading `packages/studio/src/app.ts` lazily per ADR-006), and the extension links straight to it — which is what removed the terminal from the consumer path.
- [x] T-007.2 — Review SPA: candidate list with name, description, side-effect label, confidence, observation count, annotation, UI provenance, redacted sample exchange, in `packages/studio/src/app.ts`
- [x] T-007.3 — Edit API: inline edits to name/description/schema written to the recipe and marked `user_edited`, in `packages/studio/src/api.ts`
- [x] T-007.4 — Promotion: bulk approve restricted to `read` candidates, individual approval required for `write`/`destructive`, required `confirm` parameter injected on destructive approval, unapproved candidates never exposed, in `packages/studio/src/promotion.ts`
- [x] T-007.5 — Merge engine for re-inference: keep `user_edited` values and store inferred alternatives as suggestions, retain absent tools marked `unverified` with last-observed date, report fixture-invalidating schema conflicts without overwriting until resolved, in `packages/studio/src/merge.ts`
- [x] T-007.6 [P] — Fixture writer: store ≥1 redacted fixture per approved tool, re-run redaction on write and fail if any credential-shaped value survives, in `packages/studio/src/fixtures.ts`

### Verification

- [x] V-COV_REC_002.1 — "Approve all reads" on a mixed session approves only read candidates (`e2e/studio/review.spec.ts`)
- [x] V-COV_REC_002.2 — Individually approving `delete_order` writes a required `confirm` parameter into the recipe entry (`e2e/studio/review.spec.ts`)
- [x] V-COV_REC_002.3 — With douzed running and a client connected, a saved description edit reaches the client's tool list within 30 seconds, no client restart (`e2e/studio/review.spec.ts`)
- [x] V-COV_REC_003.1 — After edit + re-record + re-inference, the edited description is unchanged and the inferred one is stored as a suggestion (`e2e/studio/recipe-merge.spec.ts`)
- [x] V-COV_REC_003.2 — Re-inference from a session missing an approved tool retains it, marked `unverified` with a last-observed date (`e2e/studio/recipe-merge.spec.ts`)

---

## WO-010 — Connector installation

Build order #9 — completes the M1 end-to-end demo: bundle install, `mcp add`, legible chat-window failures.

### Tasks

- [x] T-010.1 — `douze bundle`: emit `.mcpb` zip with `manifest.json` and the MCP server entry point, using Claude Desktop's bundled Node on macOS/Windows, in `packages/cli/src/commands/bundle.ts`. **Shipped differently:** the manifest is generated in that file (there is no checked-in `mcpb/manifest.json`) and carries **no `user_config`** — the server finds the daemon itself, so installing is a double-click and nothing else. An e2e assertion pins the absence.
- [x] T-010.2 [P] — `douze mcp add --agent claude-code`: write a stdio entry invoking `douze --mcp`, report the scope written, reject reserved names (`workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview`, `Claude Browser`) by suffixing, in `packages/cli/src/commands/mcp-add.ts`
- [x] T-010.3 [P] — `douze skills add`: install skill files describing enabled recipes' tools. **Shipped differently:** provided by incur's built-in `skills` command over the same command tree, so there is no `commands/skills.ts` of ours.
- [x] T-010.4 — Long-call survival: MCP progress notification at 60 s and every 60 s thereafter; configured ceiling cancels with a structured timeout naming tool + elapsed time, in `packages/cli/src/mcp.ts` (extends T-008.4/T-008.5)
- [x] T-010.5 — The four client-facing error states (relay not running + how to start; extension disconnected naming target; session expired naming target + sign-in instruction; never retry, never headless-fallback), in `packages/cli/src/errors.ts`

### Verification

- [x] V-COV_CON_001.1 — `douze bundle` → unzip the `.mcpb` → run its declared entry point with nothing configured (no settings form exists) → `tools/list` returns the enabled recipes' tools (`e2e/connector/desktop.spec.ts`)
- [x] V-COV_CON_001.2 — Approving a tool in a new recipe makes it callable with no reinstall and no bundle rebuild (`e2e/connector/desktop.spec.ts`)
- [x] V-COV_CON_002.1 — `douze mcp add --agent claude-code` against a scratch config writes a stdio entry invoking `douze --mcp`, the reported scope matches the changed file, `claude mcp list` reports connected (`e2e/connector/claude-code.spec.ts`)
- [x] V-COV_CON_002.2 — Registration under `workspace` is suffixed and succeeds (`e2e/connector/claude-code.spec.ts`)
- [x] V-COV_CON_004.1 — douzed stopped / extension disabled / session invalidated each produce their specified error text; no case retried or fell back to headless (`e2e/connector/failures.spec.ts`)
- [x] V-COV_CON_003.1 — A 7-minute-delayed read over MCP emits progress notifications at least once per minute and completes successfully (`e2e/connector/failures.spec.ts`)

---

## WO-002 — Capture extension: provenance, annotation, debugger fallback

Build order #10 — enriches description quality (M1 scope) but the golden-path demo doesn't block on it; can run parallel with WO-009/010 in the extension lane.

### Tasks

- [x] T-002.1 — Gesture tracker content script: accessible name + role of the last activated interactive element, document title + route path, in `packages/extension/src/provenance.ts`
- [x] T-002.2 — Attribution in the service worker: 2-second window, `background` marking with no stale provenance for gesture-less requests, in `packages/extension/src/background.ts` (extends T-001.4)
- [x] T-002.3 — In-popup annotation: free-text note attached to every exchange since the previous note, persisted as an Annotation Span with start/end positions in the CaptureStore, in `packages/extension/src/popup/` + `packages/douzed/src/capture-store.ts`
- [x] T-002.4 — Span-to-candidate propagation in inference: note attached to each candidate its span covers, prioritized over provenance for description generation, never required, in `packages/studio/src/inference/engine.ts` (extends T-005.7)
- [x] T-002.5 [P] — Per-session `chrome.debugger` opt-in: attach/detach, `Network.getResponseBody`, service-worker traffic capture, in `packages/extension/src/debugger-capture.ts`
- [x] T-002.6 — Dual-path reconciliation: an exchange captured by both interceptor and debugger is emitted at most once, in `packages/extension/src/dedupe.ts`

### Verification

- [x] V-COV_CAP_003.1 — Clicking "Create order" attaches provenance with accessible name "Create order" and the current route to the exchange (`e2e/capture/provenance.spec.ts`)
- [x] V-COV_CAP_003.2 — 5 seconds of polling with no interaction: every captured exchange is `background` with no provenance (`e2e/capture/provenance.spec.ts`)
- [x] V-COV_CAP_007.1 — A note attached between requests 2 and 3 lands on the candidate from exchange 3 and not the earlier candidates (`e2e/capture/annotation.spec.ts`)
- [x] V-COV_CAP_007.2 — An unannotated session still produces candidates; none is blocked on a missing annotation (`e2e/capture/annotation.spec.ts`)

---

## WO-011 — Drift detection

Build order #11 — M2; needs the registry write path (WO-004) and replay through the relay (WO-009).

### Tasks

- [x] T-011.1 — DriftWatcher scheduler: configured interval, silent skip when the browser relay is unavailable, in `packages/douzed/src/drift/watcher.ts`
- [x] T-011.2 — Fixture replay: `read` fixtures only — never `write` or `destructive` — through the relay, in `packages/douzed/src/drift/replay.ts`
- [x] T-011.3 — Five-way classification per tool: `ok` | `schema_widened` | `breaking` | `session_expired` | `gone`, in `packages/douzed/src/drift/classify.ts`
- [x] T-011.4 — Degradation write-back into the recipe (propagates via hot reload; healthy tools in the same recipe unaffected), in `packages/douzed/src/drift/degrade.ts`
- [x] T-011.5 [P] — Patch proposals: `schema_widened` → proposed recipe patch adding new optional fields, existing fields untouched; offer git branch commit when the recipe is in a repo, in `packages/douzed/src/drift/patch.ts`
- [x] T-011.6 [P] — Webhook notification on any `breaking` or `gone` result, in `packages/douzed/src/drift/notify.ts`
- [x] T-011.7 — `douze doctor [recipe]` on-demand command, in `packages/cli/src/commands/doctor.ts`

### Verification

- [x] V-COV_DRF_001.1 — `douze doctor` on a recipe with read/write/destructive tools: the fixture server received requests only for read tools (`e2e/drift/doctor.spec.ts`)
- [x] V-COV_DRF_001.2 — An added optional response field classifies `schema_widened` with a patch adding it as optional and no other change (`e2e/drift/doctor.spec.ts`)
- [x] V-COV_DRF_002.1 — Removing a required response field: recipe updated, running client reflects degradation without restart, affected tool fails before issuing a request, unaffected tool still succeeds (`e2e/drift/degradation.spec.ts`)

---

## WO-012 — Eject to a standalone package

Build order #12 — M3; needs approved recipes (WO-007) and the runtime execution semantics to match (WO-008); parallel with WO-013.

### Tasks

- [x] T-012.1 — PackageEjector: emit a TypeScript incur package with one command per approved tool (path + required params → `args`, optional → `options`), `output` schema from the response contract, ≥1 `examples` entry from a fixture, in `packages/studio/src/eject/emitter.ts`
- [x] T-012.2 [P] — Emission templates: `incur` as the only runtime dependency, no Douze imports, per-file header naming source recipe + version, in `packages/studio/src/eject/templates/`
- [x] T-012.3 — Determinism: byte-identical output for repeated ejects of the same recipe (sorted keys, no timestamps), in `packages/studio/src/eject/emitter.ts`
- [x] T-012.4 — Ejected execution: relay-first when douzed is reachable, headless fallback with degraded-path notice when configured, fixture-replay tests failing non-zero naming each failing tool, in `packages/studio/src/eject/templates/`
- [x] T-012.5 — `douze eject <recipe> --out <dir>` command, in `packages/cli/src/commands/eject.ts`

### Verification

- [x] V-COV_EJT_001.1 — Two ejects are byte-identical; `package.json` declares `incur` as the only runtime dependency with no Douze import; a built read command's output matches the interpreted runtime for the same arguments (`e2e/eject/package.spec.ts`)
- [x] V-COV_EJT_001.2 — A fixture altered to contradict its schema makes the emitted tests exit non-zero naming the failing tool (`e2e/eject/package.spec.ts`)

---

## WO-013 — Headless mode

Build order #13 — M3; the explicitly degraded cron path, needing only the relay substrate (WO-009); parallel with WO-012.

### Tasks

- [x] T-013.1 — Session export into the OS keychain on explicit per-target opt-in, with only a reference in configuration (never a session value), in `packages/douzed/src/headless/keychain.ts` + `packages/douzed/src/headless/config.ts`
- [x] T-013.2 — Direct execution from douzed: recipe-declared refresh endpoint applied on 401 with a single retry, in `packages/douzed/src/headless/executor.ts`
- [x] T-013.3 — Mandatory degraded-path notice on every headless invocation; on refresh failure, clear the keychain entry and report that browser relay is required, in `packages/douzed/src/headless/executor.ts`
- [x] T-013.4 [P] — `douze headless enable|disable <target>` commands, in `packages/cli/src/commands/headless.ts`

### Verification

- [x] V-COV_EXE_004.1 — With headless enabled and the browser closed, a read tool succeeds with a degraded-path notice; config holds a keychain reference and no session value (`e2e/relay/headless.spec.ts`)
- [x] V-COV_EXE_004.2 — With the stored session and refresh endpoint invalidated, the call exits non-zero, requires browser relay, and the keychain entry is empty (`e2e/relay/headless.spec.ts`)

---

## WO-014 — Remote relay: hosted MCP endpoint for clients that cannot run local processes (BUILT, LIVE-UNVERIFIED)

Build order #14 — post-release; needs the MCP surface (WO-008) and relay execution (WO-009), and
sits behind the release gates (C-1, C-2, tagged release). Serves ChatGPT, claude.ai web/mobile,
Dust, and any other hosted MCP client. Client-agnostic by construction: the only contract is
streamable-HTTP MCP; per-client differences are onboarding text, not code. Local clients (Claude
Desktop/Code, Cursor, Codex) keep the loopback path — nothing changes for them.

### Security model (decided up front)

The destructive-confirm guard is a caller-supplied `confirm: true` argument — consent UX for a
well-behaved local client, not an authentication boundary. A compromised relay or stolen endpoint
token can forge it. Therefore the remote surface is **read-only by default, enforced by the
daemon**, per-tool opt-in for writes, and destructive tools are never callable remotely in v1.

| Boundary | What crosses it | Protection |
|---|---|---|
| Browser ↔ extension | raw traffic, credentials | unchanged: redaction before anything leaves the extension |
| Extension ↔ daemon | redacted exchanges, relay execs | unchanged: install token, loopback-only |
| Daemon → relay (new) | MCP frames: tool args + full result bodies | outbound-only WSS, relay token, TLS; daemon treats this path as less trusted than loopback |
| Relay ↔ AI platform (new) | same MCP frames | per-user secret URL (v1) or OAuth (v2), TLS |
| Platform ↔ model | tool results enter the conversation | out of our control — disclosed, not mitigated |

Facts to disclose verbatim, not soften: the relay operator can read and inject traffic
(self-hosting via `DOUZE_REMOTE_URL` is the only remedy); the platform stores whatever tools
return; result bodies are live dashboard data. Strict-local-only users must not run
`douze connect`. Residual risk we own no lever for: prompt injection via attacker-authored
dashboard content steering the agent — bounded by the read-only default and per-tool allowlist.

Out of scope v1: multiple daemons per token, payload E2E encryption (platforms need plaintext),
platform IP allowlisting (egress ranges churn), remote destructive tools (no flag, no exception),
per-client adapters.

### Tasks

- [ ] T-014.0 — **PARTIAL (2026-08-11)**: the compatibility matrix is done from current vendor docs; the account-bound `tunnel-client` spike still needs a human with an OpenAI Platform org. Matrix verdict: ChatGPT Developer Mode and claude.ai explicitly support no-auth servers, Dust documents static Bearer — **no client requires OAuth**; secret goes in the URL path (both specs warn against query-param tokens); ChatGPT write tools are only safely assumed on Business/Enterprise/Edu (reads fine everywhere); claude.ai connections originate from Anthropic cloud egress even on desktop. Original: Phase-0 spike, blocks everything: OpenAI `tunnel-client` against `douze --mcp` proves the ChatGPT round-trip with zero code; compatibility matrix (auth methods accepted, streaming, write gating, plan gating) for ChatGPT, claude.ai custom connectors, and Dust. Decides secret-URL vs OAuth. Kill criterion: if every target gates writes to enterprise plans and the audience is consumer, stop here.
- [x] T-014.1 — **DONE (revised shape)**: `hello`/`welcome`/`ping`/`pong` plus session-scoped `session.open`/`session.close`/`session.closed` and a bidirectional `mcp.message{sid, message}` carrying opaque JSON-RPC — sessions give each platform client an isolated MCP server instance so ids cannot collide and `initialize` stays per-session. `REMOTE_MAX_SESSIONS`, `REMOTE_SESSION_IDLE_MS` exported. Original: Remote frame set in `packages/shared/src/protocol.ts`: `hello` (token auth), `mcp.request`/`mcp.response` carrying opaque JSON-RPC, existing heartbeat discipline. No capture frames, no buffering — a call during a disconnect fails fast like `extension_disconnected`.
- [x] T-014.2 — **DONE (2026-08-11)**: `douze connect|disconnect` with `--rotate`, `--allow-writes`, `--bearer` in `packages/cli/src/commands/connect.ts`; the outbound bridge in `packages/cli/src/remote-bridge.ts`, started from `packages/cli/src/commands/daemon.ts`. **Deviation:** device-code pairing was replaced by daemon-initiated registration — the daemon POSTs `/register` and the relay returns `{token, mcp_path}`, so no code is typed anywhere and the secret still only ever appears in the local terminal. The env var is `DOUZE_REMOTE_URL`. Original: `douze connect` / `douze connect --rotate` / `douze disconnect` in `packages/cli`: device-code pairing (short TTL, single-use, code shown only in the local terminal), relay token at `$DOUZE_HOME` mode 0600, one outbound WSS from the daemon bridged into the existing `mcp.ts` machinery. Opens no new listeners; disconnect revokes both ends.
- [x] T-014.3 — **DONE (2026-08-11)**: `filterRemoteRegistry` in `packages/cli/src/remote-bridge.ts` scopes the per-session MCP surface (reads always, writes on `allow_writes`, destructive never); frame validation via `RemoteRelayMessage`, `REMOTE_MAX_SESSIONS` concurrency cap, and the relay's 1 MB body cap, 8 in-flight, and 120 s per call in `packages/relay/src/server.ts`; the audit line lands in `$DOUZE_HOME/remote-audit.jsonl` and `douze status` prints the last five (`packages/cli/src/commands/daemon.ts`). **Deviation:** writes are opted in by one `allow_writes` flag, not a per-tool allowlist; the only per-tool list that shipped is `expose`, which exempts a tool from the T-014.4 result gate. The security-model paragraph above says "per-tool opt-in for writes" and the code does not do that.
- [x] T-014.4 — **DONE (2026-08-11)**: `gateResult` in `packages/cli/src/remote-bridge.ts` runs `findSurvivingSecrets` over every `tools/call` result on the remote path and returns a JSON-RPC error naming the tool and the finding paths; the per-tool override is the `expose` list in `relay.json`.
- [x] T-014.5 — **DONE (2026-08-11)**: `packages/relay` — stateless in-memory endpoint map, streamable-HTTP MCP at `/m/<secret>`, a registration limit per peer address (behind a proxy, the proxy), 8 in-flight per endpoint, 1 MB bodies, 120 s calls, in-flight calls failing on daemon disconnect, sha256-hashed secrets, and a log carrying only timestamps, event names, durations, and an 8-character endpoint hash prefix (`packages/relay/src/server.ts`, `packages/relay/README.md`). **Deviation:** no SSE pass-through — `GET /m/<secret>` is 405 and v1 has no server-initiated stream, so a client sees tool changes when it next polls `tools/list`.
- [x] T-014.6 — **SKIPPED per its own condition (2026-08-11)**: the T-014.0 matrix found no target client requires OAuth (ChatGPT and claude.ai accept no-auth servers; Dust's documented path is a static Bearer header, covered by an optional relay-side check). Original: Conditional on T-014.0: minimal OAuth 2.1 + PKCE + dynamic client registration, access tokens short-lived and bound to the pairing, DCR rate-limited. Skipped if secret-URL suffices for all target clients.
- [x] T-014.7 — **DONE (2026-08-11)**: attach steps print from `instructions()` in `packages/cli/src/commands/connect.ts`; the "Remote clients (ChatGPT, claude.ai, Dust)" section in `README.md` carries the same wording plus self-hosting; the trust-model table and the three disclosure facts now live in `INTERN_VERIFICATION.md` section D, with the live-platform gap recorded there.

### Verification

- [ ] V-014.1 — **PARTIAL**: the surface half is unit-covered — `packages/cli/src/remote-bridge.test.ts` proves the filter offers reads only by default, adds writes on opt-in, never offers a destructive tool whatever the config says, and that the bridge serves a session the scoped surface rather than the local one. The "zero target requests" half needs the fake-connector run in V-014.5. Original: A remote write is refused by default with zero target requests, succeeds only after explicit opt-in; a remote destructive call is refused regardless of flags or a forged `confirm: true`.
- [x] V-014.2 — **DONE**: `packages/relay/src/relay.test.ts` interleaves four calls across two enrolled endpoints, asserts each id returns its own tenant's result, and asserts one tenant's session id is a 404 on the other's URL while both are live.
- [x] V-014.3 — **DONE**: `packages/relay/src/relay.test.ts` sweeps every stderr line of a full register → connect → initialize → call → close run for the JWT in the result, the endpoint token, the path secret, the bearer, the tool name, and the session id; `packages/cli/src/remote-bridge.test.ts` refuses a result embedding a JWT, asserts the JWT is absent from the refusal, and passes the same result after the `expose` override.
- [ ] V-014.4 — **PARTIAL**: `packages/relay/src/relay.test.ts` covers daemon disconnect failing an in-flight call immediately with `502 daemon_offline`, and `packages/cli/src/remote-bridge.test.ts` covers the bridge tearing every session down on socket close. Parity of session expiry, degraded-tool refusal, and zero-retry with the local path is unverified — those guards live behind the same MCP surface but have not been exercised through the remote path. Original: Session expiry, degraded-tool refusal, and zero-retry semantics through the remote path are identical to the local path; daemon disconnect fails all in-flight remote calls immediately.
- [ ] V-014.5 — A fake connector speaking plain streamable-HTTP MCP (the entire compatibility contract) completes list + read through relay → daemon → extension → fixture.

---

## WO-015 — One brain, two pipes: the extension becomes the product (IN PROGRESS)

Decided 2026-08-11. A consumer with no terminal has nothing that starts douzed — the `.mcpb` was
doing that job by proxy, because Claude Desktop spawns `douze --mcp` and that process hosts the
daemon. So the extension, which already captures, redacts and executes, takes over storage,
recipes, inference, review and the outbound connection, and the stateful daemon goes away.

**The shape.** The extension is the single source of truth and the only thing a consumer installs.
Two transports attach to it and hold no state of their own:

```
  ChatGPT / claude.ai / Dust ──https──▶ relay ──┐
                                                ├──ws──▶ EXTENSION ──▶ your signed-in tabs
  Claude Code / Cursor / Desktop ──stdio──▶ bridge ──┘        (recipes, storage, inference,
                                                               review UI, guards, audit)
```

Both speak the **same attachment protocol** to the extension, which therefore has one
implementation and does not care which is on the far side. The relay is the cloud pipe already
built and deployed (WO-014); the bridge is a new ~200-line local pipe that restores stdio MCP for
developer clients. Neither may ever hold recipes, storage or inference — if a pipe grows state,
this design has failed.

**Trust is a property of the attachment, decided by the extension, never claimed by the pipe.**
The extension derives it from what it dialled: a loopback `ws://127.0.0.1` bridge that the user
paired in person is `local`; anything else is `remote`. Guards live in the extension in one place
and read that level:

| | `remote` (relay) | `local` (bridge) |
|---|---|---|
| read tools | always | always |
| write tools | opt-in per attachment | always |
| destructive tools | never, no setting restores them | allowed, `confirm: true` required |
| result secret gate | enforced, `expose` list to exempt | enforced |

This is why the developer regression the earlier plan accepted does not happen: Claude Code keeps
everything it has today, with no cloud in the path. The rule "destructive is never remote" stops
being arbitrary — a relay operator or a stolen URL can forge a `confirm` argument, a process on
your own machine that you paired is a different claim.

### Package graph after the port

| Package | Role |
|---|---|
| `@douze/shared` | schemas, redaction, protocols — unchanged |
| `@douze/studio` | inference, descriptions, review page — becomes a library the extension bundles; its server-side halves go |
| `@douze/extension` | the product |
| `@douze/mcp-host` | **new** — MCP termination + the attachment protocol, shared by both pipes |
| `@douze/relay` | HTTP/WSS transport, multi-tenant auth — keeps its own concerns, gains `mcp-host` |
| `@douze/bridge` | **new** — stdio transport + loopback WS + pairing |
| ~~`@douze/douzed`~~, ~~`@douze/cli`~~ | deleted at the end of phase 4 |

One MCP termination implementation serving two transports is the point; two would be the failure.

### The attachment protocol (the linchpin — settle it before phases 2 and 3)

Extension → host: `hello{extension_version}`, `pong`, `surface.push{tools[]}` on connect and on
every recipe change, `tool.result{id, result | error}`.
Host → extension: `welcome{heartbeat_ms}`, `ping`, `tool.call{id, name, args, trust}`.

The host owns MCP sessions entirely — `initialize` and `tools/list` are answered from the cached
surface, so a connector added while Chrome is closed still lists tools instead of looking broken,
and a `surface.push` becomes `notifications/tools/list_changed`. The extension tracks no session
state, because a service worker Chrome can evict cannot hold any: an in-flight promise is not
persistable and an inbound frame cannot wake a dead worker. `tool.call` is the only thing that
needs the browser awake, which is a constraint Douze already has.

### Phases

Each phase ends somewhere shippable. Phase 0 is not optional.

**Phase 0 — de-risk before rewriting (days).** Close C-1 on the *current* architecture: record a
real Openfort session, approve, and complete a read from a client. Answer Q5 — whether MAIN-world
interception survives real sites' CSP — on three real targets. Both test exactly the parts this
port carries over unchanged (inference is pure TS, execution already lives in the extension), so a
failure here invalidates the product, not just the plan. Also open the Chrome Web Store listing
early: review latency and the data-disclosure wording are on the critical path and neither is code.

**Phase 1 — the extension stands alone (1–2 weeks).** Capture → approve → recipes, with no daemon
running at all.
- [x] T-015.1 — **DONE (2026-08-11)**: `packages/extension/src/store.ts` — IndexedDB `douze-capture` with a `(session_id, position)` compound index as the ordering guarantee, `by_end_position` for annotation spans, and `appendExchange` as the only method that writes an exchange: it re-applies `redactUrl`/`redactHeaders`/`redactBody` and throws on `findSurvivingSecrets` over the **whole record**, not just url + headers + bodies. `db` is private and no object-store access is exported, so the gate cannot be routed around from outside the file. `unlimitedStorage` is in `packages/extension/public/manifest.json`.
- [ ] T-015.2 — **PARTIAL (2026-08-11)**: `packages/extension/src/recipes.ts` — `chrome.storage.local` under `recipe:`/`fixture:` prefixes, `chrome.storage.onChanged` as the hot-reload signal, `parseRecipe` unchanged on every write, and a fixture gate on `findSurvivingSecrets`. A recipe is stored **as its YAML source string**, so `exportRecipe`/`exportAll` round-trip byte-identically with comments and key order; `importFiles` validates the whole set first and writes nothing on any error or name collision. **The UI half does not exist**: no download, no file picker, and no caller outside `recipes.test.ts`, so this is an API today and not a feature. The export layout deliberately mirrors `~/.douze` (`recipes/<name>.yaml`, `fixtures/<recipe>/<tool>.json`) so a daemon-era directory is a valid import set once something can open one.
- [ ] T-015.3 — **PARTIAL (2026-08-11)**: the port is done — `packages/studio/src/browser.ts` is the single browser entry point and `packages/extension/src/review-session.ts` consumes `candidatesFrom`, `authFrom`, `approve`, `prepareSave` and the rest wholesale rather than re-implementing anything; `browser-entry.test.ts` fails the build if a `node:*` builtin reaches the bundle. **Model descriptions were not built**: descriptions are `describeSync` only, there is no `options_page`/`options_ui` in the manifest to hang a toggle on, and so the 30 s fetch cap has nothing to cap. Off by default is satisfied by absence, which is not the same as shipped.
- [x] T-015.4 — **DONE (2026-08-11)**: review is `packages/extension/public/review.html` + `packages/extension/src/pages/review.ts`, opened by the service worker as `chrome.runtime.getURL('review.html?session=<id>')` — the expired-link failure mode is gone with the daemon's HTTP review UI. The connect page ported alongside it as `packages/extension/src/pages/connect.ts`. **Deviation:** `packages/studio/src/app.ts` could not be reused because it was already dead — nothing imported it — so it was deleted with the daemon in T-015.13 rather than ported, and the page was rebuilt on `@douze/studio/browser` directly.
- [ ] T-015.5 — **PARTIAL (2026-08-11)**: `packages/extension/src/har.ts` — `importHar` does no redaction of its own by design and routes every entry through `CaptureStore.appendExchange`, so T-015.1's gate applies; refusals are reported per entry in `refused[]` and never abort the import. **There is no file picker and no caller** outside `har.test.ts` — no `douze:har*` message type and no `<input type="file">` in any page — so HAR import is unreachable from the UI.
- [ ] V-015.1 — With the daemon binary absent from the machine: record on the fixture, infer, approve, and see the recipe in storage; a capture carrying a JWT is refused by the gate; export then re-import round-trips a recipe byte-identically.

**Phase 2 — the cloud pipe (1 week).** Hosted assistants work end to end.
- [x] T-015.6 — **DONE (2026-08-11)**: `packages/mcp-host` — `McpHost` in `src/host.ts` answers `initialize`, `ping`, `tools/list` and `tools/call`, with `initialize`/`tools/list` served entirely from the cached surface so a connector added while Chrome was closed still lists tools; `tools/call` becomes a `tool.call` frame. `capabilities.tools.listChanged` is declared **unconditionally**, empty surface or not, which is the trap the SDK's lazy handler installation set (a session that connected before the first recording answered `tools/list` with "Method not found" for its whole life). `pushSurface` deep-compares before emitting `notifications/tools/list_changed`. `src/protocol.ts` is the attachment protocol; the package imports no `node:*` and knows about no transport.
- [x] T-015.7 — **DONE (2026-08-11)**: `packages/relay/src/server.ts` terminates MCP instead of forwarding it — one `McpHost` per session, one cached surface per endpoint replaced wholesale by each `surface.push` and fanned out to every live session including one created later. `WAKE_GRACE_MS = 40_000` holds a `tools/call` that arrives with no live socket, sized off `chrome.alarms`' 30 s floor; `initialize` and `tools/list` never wait. A dropped socket fails everything in flight at once with retryable `extension_disconnected` and **re-sends nothing**. The disclosure that the relay now holds every tool name, description and schema is in `packages/relay/README.md` and in `INTERN_VERIFICATION.md`.
- [x] T-015.8 — **DONE (2026-08-11)**: `packages/extension/src/attach.ts` — one `Attachment` implementation for both hosts, `chrome.alarms` at the 30 s floor recreated at every worker start (an evicted worker keeps no timers), 20 s heartbeat with a 2.5× silence timeout, exponential backoff only for a dial that never reached `welcome`, and `surface.push` on every connect as well as on every change, because a stale host cache is corrected by nothing else. **The trust on an inbound frame is deliberately dropped** and the level is derived from what was dialled.
- [x] T-015.9 — **DONE (2026-08-11)**: `packages/extension/src/guards.ts` is the only home for policy — `attachedSurface` filters at push time, `checkPolicy` refuses at call time whatever was pushed, and both are required because filtering alone is a UI courtesy. Covers degraded refusal (ordered first, since "this tool is broken" outranks "you may not call it"), the trust table, destructive `confirm`, per-tool rate limiting, timeout, `session_expired` classification, `shapeResult` with a UTF-8-safe 32 KB cut, `gateResult`, and the audit log. **Deviations from douzed:** a queued call waits at most 20 s rather than the full 60 s window — a call parked across a worker eviction is a lost call, not a delayed one — and the audit log records no arguments at all, because `chrome.storage.local` is readable by every extension context and syncs, which deletes the leak class the daemon needed a shape gate for. A destructive tool refused for a remote host answers `trust_refused`, never `confirm_required`, so no agent is told to retry with an argument that can never work.
- [x] T-015.10 — **DONE (2026-08-11)**: `douze:connect:start|rotate|stop|writes` in `packages/extension/src/background.ts` call the relay's `POST /register`, `POST /rotate` and `DELETE /register`, storing the pairing at `attach:relay`; `attach.ts` picks a change up on its own alarm, so nothing reaches into the socket. `stop` clears the pairing whether or not the relay answered — a user ending the sharing of their dashboard must not be blocked by a network failure — and warns instead of erroring. The page adds the write opt-in, the per-trust `expose` lists, and the bridge pairing-code entry. A non-technical user now goes install → watch a site → approve → Connect → Copy → paste, with no terminal anywhere.
- [ ] V-015.2 — A fake connector speaking streamable-HTTP MCP completes list + read with no daemon anywhere; a write is refused until opted in; a destructive call is refused whatever it sends; the same run against the deployed relay.

**Phase 3 — the local pipe (3–5 days).** Developer clients come back at full trust.
- [x] T-015.11 — **DONE (2026-08-11)**: `packages/bridge` — `startBridge` in `src/bridge.ts` runs newline-delimited JSON-RPC on stdin/stdout and a loopback WS server the extension dials, over one `McpHost`. **stdout carries protocol and nothing else**; every diagnostic goes to stderr. It holds no recipes, storage, inference or policy — only the pairing credential. Same 40 s wake grace as the relay, and it matters more here because a client spawns the bridge before the browser has dialled in. `vite.config.ts` emits one self-contained `dist/index.js` with a shebang. **Deviation:** the bridge took its own port range, `BRIDGE_PORT_RANGE = 8912–8916`, rather than douzed's `PORT_RANGE` (8787–8791) from `@douze/shared` — during the port both were live and speaking different protocols, so a shared range would have had the extension meeting the wrong server. The walk itself stays, because a bridge is per MCP client rather than per machine. **Not distributable yet:** the package is `private: true` and unpublished, so the `npx @douze/bridge` line in its own README does not work; the built `dist/index.js` is what an MCP client spawns today.
- [x] T-015.12 — **DONE (2026-08-11)**: `packages/bridge/src/pairing.ts` — an 8-character code (~39 bits, Crockford alphabet minus the ambiguous letters) printed to stderr only, `ATTEMPTS = 10` failures before the process refuses every socket for the rest of its life, and a 32-byte secret handed back on the raw `welcome` for the extension to pin while only its sha256 reaches `$DOUZE_HOME/bridge.json` at mode `0600` (set by an explicit `chmodSync`, because `mode` applies at creation only). Both comparisons are `timingSafeEqual`. An unpaired socket is closed 1008 **before the host is told anything attached**. `packages/bridge/README.md` states the residual plainly: `0600` stops other users, not other code running as you.
- [ ] V-015.3 — A real stdio client (Claude Code) lists and calls tools through the bridge; a destructive tool succeeds with `confirm: true` and is refused without it; an unpaired bridge is refused.

**Phase 4 — retire the daemon (1 week + review latency).**
- [x] T-015.13 — **DONE (2026-08-11)**: `packages/douzed` and `packages/cli` are gone, with no shims and no re-exports; `pnpm-workspace.yaml` and the six remaining packages carry no reference to either. Headless mode, `.mcpb`, `douze-server.zip` and eject went with them, and `.github/workflows/release.yml` now publishes one asset. **Deviation:** `packages/studio/src/app.ts` went too — it turned out to be already dead (no importer) rather than the review UI T-015.4 was meant to reuse. **Two residues left behind, both harmless and both wrong to leave:** `Douze.mcpb` and `douze-server.zip` are still *tracked* files at the repo root and are no longer even in `.gitignore`; and `packages/shared/src/recipe.ts` still accepts `auth.mode: 'headless'` in the schema with no implementation anywhere behind it, so such a recipe loads and then executes through the browser regardless.
- [ ] T-015.14 — **IN PROGRESS (2026-08-11)**: `e2e/` currently holds `harness.ts`, `global-setup.ts`, `eval/` and a `README.md` that is the requirements list the replacement inherits — no specs yet. **Deviation:** `e2e/metrics.mjs` was deleted rather than ported, because both of its halves were daemon-only: the secret sweep walked `DOUZE_HOME`, and the relay-overhead measurement called douzed's `/relay/...` route. Its patterns are preserved verbatim in `e2e/README.md` and it must be rebuilt against extension storage read out through the service worker; until it is, C-4 has no evidence on this architecture.
- [x] T-015.15 — **DONE (2026-08-11)**: `README.md` rewritten for one install — extension only, no terminal in the consumer path, the bridge named as the single exception; the daemon, the `douze` CLI, `.mcpb`, `douze-server.zip`, headless and eject are gone from it. The "What Douze does not do" correction is the substantive edit: "everything stays on your computer" now holds only until a hosted assistant is connected, after which the relay operator **and** the AI provider both see tool arguments and full result bodies. The release section states what is true — no tag, no git remote, no Web Store listing, so building it yourself is the only path. `INTERN_VERIFICATION.md` rewritten around the new boundaries (extension message guards, bridge pairing, relay endpoint auth) with the daemon's install-token/loopback-API inventory removed, and a known-gaps section that names what has never been verified. The `~/.douze` migration note is in README's recipe-format section: the importer takes the daemon's exact layout, and nothing can open a directory for it yet.
- [ ] V-015.4 — Full suite green on the new harness; secret sweep clean over extension storage; the Web Store build contains no `new Function` (a bundler config that forces Node conditions silently swaps ajv back in — grep the worker bundle as a build guard).

### Risks held open deliberately

- **Web Store review.** Broad host permissions plus an outbound connection to a third-party relay is exactly what a reviewer stops on. The per-site permission prompts help; the listing must state plainly what leaves the machine and when. Start it in phase 0.
- **Worker eviction during long work.** Inference is fast enough, but any long-running loop or a fetch over 30 s kills the worker. Everything long must be resumable or chunked.
- **Bundle size.** ~230 KB for MCP alone if the SDK ends up in the extension; with relay-owned sessions it should not need to be there at all.
- **This rewrites the local half before C-1 has ever proven the product once.** Phase 0 exists precisely because of that, and is why it is not optional.

## Open Questions (PRD 5.3 — resolve during implementation)

- [x] Q1 — **RESOLVED (verified)**: incur's `Mcp.serve()` does NOT support mid-session re-registration — `collectTools` snapshots once at connect. The escape hatch works and was executed end-to-end: `Cli.toCommands` (live Map) + `Mcp.collectTools` + `Mcp.callTool` + own `McpServer`, whose `registerTool()` handle fires `notifications/tools/list_changed` automatically. Original question: Does incur support re-registering tools mid-session and emitting `listChanged`? Spike in M0 (T-008.1). Fallback: a thin wrapper that re-emits `tools/list` on reload.
- [ ] Q2 — How does Claude Desktop behave with a wide tool surface? Claude Code's tool search absorbs it; Desktop is unverified. Fallback: the `enabled` flag; next step, named profiles (ADR-007).
- [x] Q3 — **PARTIALLY RESOLVED**: with a *remote* model (via the local `claude` CLI) real agent selection accuracy on the reference recipe is 100% (28/28), well clear of the 90% bar; the offline BM25 proxy scores 96.4%. A LOCAL model has not been benchmarked, so the local-first question is still open. Original:  Is a local model good enough to hold the 90% selection-accuracy bar, given description generation conflicts with local-first otherwise? Measure with the eval harness (T-006.4) against a local endpoint.
- [x] Q4 — **RESOLVED (measured)**: relay overhead is **1.2 ms** median over a direct in-page fetch (relay 2.9 ms vs direct 1.7 ms, p95 6.1 ms) against the fixture app — the PRD's 150 ms target was a guess and the real figure is ~125x under it. All the extra hops are loopback or in-browser, so the *overhead* figure holds for a remote target too. Relay-call batching is not needed. Measured by `e2e/metrics.mjs`. Original:  Is relay latency acceptable for agent loops making many sequential calls? The 150 ms target is a guess until WO-009 measures it. Fallback: relay-call batching.
- [ ] Q5 — Does MAIN-world interception hold up on real targets, or do CSP and page hardening push sessions onto the debugger path? Test three real targets before WO-001 locks the strategy. Fallback: the `chrome.debugger` opt-in path (ADR-002).
- [ ] Q6 — Should recipes be portable between machines given environment-specific fixtures and base URLs? Leaning: per-target config overlays rather than environment-aware recipes.

---

## Post-review gap found in use

The PRD 5.2 golden path names `douze studio`, `douze doctor <recipe>`, and `douze eject <recipe>`.
All three were BUILT and tested (review UI, DriftWatcher behind `POST /doctor/:recipe`,
`eject()`), but none was wired as a CLI command — the acceptance tests exercise the underlying
functions and the daemon endpoint, not those entry points, so a green suite hid it. `doctor` and
`eject` are now wired in `packages/cli/src/commands/maintenance.ts`. `douze studio` was NOT wired
and no longer needs to be: douzed serves the review page and the extension links to it, so the
review path never touches a terminal. Verified end to end: import a HAR -> the review UI infers 3
candidates -> bulk approve takes only the 2 reads and skips the write (AC-REC-002.3) -> recipe and
fixtures written -> `douze eject` emits 6 files with `incur` as the only runtime dependency. `doctor` is deliberately CLI-only (`mcp: false`): a Doctor Run issues
live requests and can rewrite a recipe, which is a maintenance decision, not an agent's call.

## Review status (honest record)

- **Core review (packages/shared, packages/douzed)** — completed by an adversarial reviewer. 21 findings; the 12 that mattered were fixed with regression tests (URL-query secret leak, form-encoded body leak, daemon crash on a refused WS message, doctor degrading recipes on transient failures, doctor hijacking the user's git HEAD, null-blind drift comparison, widened fields written at the wrong schema depth, HAR origin selection losing to CDNs, phantom annotation spans, unaudited secrets in the log, session-id mismatch, fixture re-parsing per relay call).
- **Ponytail audit (all 5 packages)** — completed. Removed a 27-line re-export shim and a duplicate `DOUZE_TOKEN` config key that was also a live AC-EJT-002.1 bug.
- **Final review (packages/cli, packages/studio, packages/extension, e2e)** — **DELIVERED** (late; an earlier note in this file said otherwise and was wrong). All 5 categories covered: all 18 e2e specs, all unit tests, all source in the three packages. Findings and disposition:
  - **FIXED** AC-INF-004.4 violation — the GraphQL input schema was inferred from ALL exchanges including 200-with-errors failures, so a rejected call demoted the fields it omitted to optional and the tool advertised that an agent could reproduce exactly the request the server refused. The test that "covered" this was vacuous; it now discriminates and is mutation-verified.
  - **FIXED** AC-RUN-004.2 boundary bug — `Buffer.subarray(cap).toString()` splits a UTF-8 sequence into a 3-byte U+FFFD, returning up to 2 bytes OVER the 32 KB cap while `returned_bytes` reported the violation as compliant. Both the CLI and the duplicated cut in emitted eject code now use a sequence-safe cut. Mutation-verified: reverting reproduces 32770 bytes.
  - **FIXED** TR-6 gap in eject — fixtures were serialised into shippable generated source with no leak gate. `loadFixture` now runs `findSurvivingSecrets` and refuses.
  - **FIXED** AC-CAP-002.3 data loss — the Reconciler counted ordinals per source but keyed claims source-blind; because the oracle sees a superset of MAIN-world traffic, an oracle-only exchange sharing a URL with page traffic was silently DROPPED (the code comment claimed the opposite failure mode). Now matches on the request's own `started_at`, with a regression test for the interleaving.
  - **FIXED** AC-REC-003.1 — renaming a tool in review duplicated it on every re-inference and falsely marked the renamed one `unverified`, because merge matched on name. Now matches on request identity.
  - **FIXED** relay traffic was captured into an active recording session (Douze inferring candidates from its own replays); the Executor Tab now never selects the recording tab.
  - **FIXED** the extension's `finalize` documented "no unredacted payload crosses the loopback boundary" but skipped `redactUrl`.
  - **FIXED (product)** cold auto-start ceiling was 15 s, which fails a slow first run on a real machine; now 45 s and configurable.
  - **NOT FIXED, accepted:** rapid-click provenance can attach the later of two gestures when a second click lands between `fetch()` and request-body drain (MEDIUM-LOW); oracle/debugger drafts never set `tab_id` so AC-CAP-002.4 traffic is always `background` (LOW). Both are recorded here rather than silently carried.
  - Verified-fine by the reviewer, do not re-investigate: JSON-Schema→Zod for every shape inference emits, interceptor SSE/streaming passthrough, relay not recursing through the patched fetch, `describe()` failing closed on the leak gate, and every e2e "target saw nothing" claim reading the fixture server's own log.

## Found in live use (2026-08-06)

The first real install on a real machine — the C-1 run below — found six defects that every
green suite had missed, because all six live outside what the suite exercised.

- **FIXED: the connector never started.** `serveMcp` awaited a daemon before connecting its
  transport, and got that daemon by re-exec'ing `process.execPath`. Claude Desktop runs MCP
  servers in an Electron UtilityProcess: `execPath` is the Claude binary, there is no Node to
  spawn, and the `runAsNode` fuse is off, so the spawn launched the app. The wait timed out at
  45 s, `initialize` was never answered, and the process exited — the extension reported that it
  could not reach anything, and `~/.douze` was never created. douzed now runs **inside** the
  `douze --mcp` process (`hostOrAdopt` in `packages/cli/src/daemon-client.ts`), later clients
  adopt it over loopback, and the transport connects before the daemon is touched. Covered by
  `e2e/connector/cold-start.spec.ts`, which sets `DOUZE_ENTRY` to a nonexistent path so any
  return to re-exec fails the suite.
  *Why the suite missed it:* `desktop.spec.ts` starts a daemon through the harness first, so the
  cold-start path — the only path a real user takes — was never run.
- **FIXED: recording a real dashboard retained nothing.** `shouldCapture` required the target
  origin to be in the session's origin list. `dashboard.openfort.io` calls `api.openfort.io`, so
  every request that mattered was dropped and two recordings produced zero exchanges. Live
  capture now passes `origins: null`: the recorded tab already scoped the request (interceptor
  registered on the granted origin, oracle filtered on the tab id, debugger attached to that
  tab), and the noise list plus the content type remain. The popup asks Chrome for permission on
  the origins actually seen when the session ends, because the relay replays inside a tab on the
  **target** origin; an ungranted origin now fails with a sentence rather than a Chrome internal
  error.
  *Why the suite missed it:* every capture spec uses a fixture app that serves its own API, so
  no test had ever recorded a site whose API lives on another host.

- **FIXED: every ordinary API URL read as a credential.** `looksLikeCredential` judged a URL as
  one string, and its generic heuristic is "40+ characters, mixed alphabet, no spaces, contains a
  digit, entropy > 3.5" — which describes `https://api.example/v1/players?limit=20`, not a secret.
  The write gate refused **30 of 31** exchanges from the live dashboard on that basis; the one
  class that survived was GitHub raw URLs, which are 96 characters but contain no digit, so the
  review page showed nothing but GitHub. A URL is now judged part by part (path segments and query
  values, decoded), and `redactUrl` replaces a credential-shaped path segment as well as a query
  value, so the gate and the redactor agree about URLs too. Proven from the user's own session:
  `rg -o "credential at [^\"]*" ~/Library/Logs/Claude/mcp-server-douze.log`.
- **FIXED: the daemon refused every exchange from a developer console, silently.** Redaction
  removed values by *key name*; the write gate in `CaptureStore.appendExchange` detected them by
  *value shape*. Openfort's API returns `{"publishableKey": "pk_test_…"}` — a name no list
  contains — so redaction left it and the gate refused the exchange. Two more recordings retained
  nothing while the extension counted every request, and the refusal went to a stderr that a
  detached daemon discards, so it was invisible from every angle. `redactBody`, `redactHeaders`
  and `redactFormBody` now apply the gate's own test (`looksLikeCredential`), as `redactUrl`
  already did; the value becomes a length-preserving placeholder and the exchange is stored.
  TR-6 is unchanged and asserted directly. The gate stays as defence in depth.
  *Behaviour change, security-adjacent:* the store, the fixture writer and the description-model
  gate used to REFUSE a credential under an innocuous key; they now redact it and proceed. The
  audit log likewise keeps each argument with a placeholder instead of collapsing every argument
  into "withheld".
- **FIXED: `douze stop` could never stop a connected daemon.** `wss.close()` stops new upgrades
  but leaves an established socket open, so `server.close()` waited on a connection that never
  ends — with the extension attached, which is the normal state, the process hung and kept the
  port while `stop` reported success. Every live socket is now terminated first, and
  `CaptureStore.close()` is idempotent. Mutation-verified: without the terminate, the test hangs.
- **FIXED: the review button did nothing.** The popup asked for permission on the origins the
  session recorded and chained "open the review page" onto the answer. Chrome CLOSES a popup to
  show a permission prompt, so the continuation never ran. The service worker owns that tab now,
  and opens it whichever way the user answers.

All five are the same shape of gap: the fixture is friendlier than the world, and a failure that
only ever reached a discarded stderr may as well not have been reported. Worth remembering when
reading a green run below.

## Cleanup & Review

- [ ] C-1 — Live verification: record a session against https://dashboard.openfort.io/ in Helium, infer, review, approve, and complete a real read action from an MCP client and the CLI (Part 0 exit criterion, M1). **IN PROGRESS** — the install and daemon halves now work (daemon up, extension paired, review UI reachable); the two defects above were found and fixed during it. A recording that retains exchanges on the live target is still outstanding.
- [ ] C-2 — Second-recipe check: add another recipe after C-1 and confirm its tools appear in a running client with zero reinstalls or reconnects (AC-CON-001.4)
- [x] C-3 — **PARTIAL**: relay overhead 1.2 ms (<150 ms PASS), trimmed result 144 B (<2 KB PASS), agent selection accuracy 100% (>=90% PASS), fixture replay pass rate 100%. Record-to-callable time needs the live run (C-1). Original:  Success-metric pass: measure record-to-callable time (<15 min), relay overhead (<150 ms median), trimmed result size (<2 KB median), fixture replay pass rate (≥95%) against PRD 1.5
- [x] C-4 — **CLEAN**: `e2e/metrics.mjs` sweeps every artifact under DOUZE_HOME (recipes, fixtures, captures.db, audit.jsonl, token) for JWTs, prefixed keys, and the fixture's own session/token/password values. Zero findings. Original:  Security sweep: grep the recipe dir, fixtures, SQLite DB, logs, and ejected output for credential-shaped values (TR-6); confirm redaction invariants hold at every persistence boundary
- [x] C-5 — **CLEAN**: `tsc --noEmit` clean on all 5 packages; `oxlint --deny-warnings` exits 0 (3 useless spreads removed, 8 deliberate ones given justified inline ignores); 242 unit tests and 41 Playwright specs green. Original:  Zero-warnings pass: `oxlint`, `tsc --noEmit`, `vitest`, Playwright suite all clean across the workspace
- [x] C-6 — **DONE**: ponytail audit removed `douzed/src/types.ts` (27-line re-export shim, one consumer) and the duplicate `DOUZE_TOKEN` config key, which was also a real AC-EJT-002.1 bug. Original:  Dead-code and simplification review: remove unused exports, collapse speculative abstractions, verify each package's boundary matches the blueprints (douzed stays small per TR-5)
- [x] C-7 — **DONE**: `README.md` — golden path verbatim from PRD 5.2, architecture, recipe format reference with the load-time constraints, package map, development and live-verification instructions. Original:  Docs: README covering the golden path verbatim from PRD 5.2, recipe format reference, and the documented `listChanged` restart limitation (AC-RUN-002.4)
