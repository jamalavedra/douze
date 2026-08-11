# e2e

Five specs driving the real product in a real browser: the unpacked extension in Helium, the
fixture app as the signed-in dashboard, and both pipes as the processes a user actually runs.
No daemon is started anywhere, because there is none — `@douze/douzed` and `@douze/cli` were
deleted in T-015.13 and the 24 specs that booted them went with them (T-015.14 wrote these).

```
pnpm verify:e2e     # the release gate: the five below
pnpm e2e            # everything, same thing today
```

macOS only, and Helium must be at `/Applications/Helium.app`: an MV3 service worker does not run
under old headless, so the suite runs headed, one worker, against a fixed fixture port.
`DOUZE_FIXTURE_ORIGIN` moves that port (`global-setup.ts` bakes whatever it says into
`host_permissions`, because `chrome.permissions.request` needs a gesture Playwright cannot supply).

## What each spec holds

| Spec | Proves | Replaces |
|---|---|---|
| `journey.spec.ts` | V-015.1 + V-015.2 end to end: record on a signed-in dashboard, approve in the extension's review page, read the recipe back out of extension storage, and call the tool from a hosted connector. Asserts the daemon packages are absent from the machine. | `verification/full-app.spec.ts`, `capture/*`, `studio/review.spec.ts` |
| `relay.spec.ts` | The cloud pipe, including the two cases the WO-015 relay exists for: `tools/list` answered while **Chrome is closed**, and a call made in that state parked and then served once the worker re-dials inside the wake grace. Uses a persistent profile and genuinely closes the browser. | `relay/execution.spec.ts`, `remote/connector.spec.ts` |
| `guards.spec.ts` | Every guard at `remote` trust, through a host that lies: a write refused until opted in, a destructive tool never offered *and* refused when asked for anyway, the result secret gate and its per-trust exemption, and a degraded tool that announces itself and refuses. | `relay/guards.spec.ts`, `runtime/surface.spec.ts`, part of `drift/degradation.spec.ts` |
| `bridge.spec.ts` | The local pipe at full trust, driven by a real stdio MCP client: an unpaired process refused, a paired one listing the destructive tool, which then succeeds with `confirm: true` and is refused without it. | `connector/claude-code.spec.ts`, `desktop.spec.ts`, `cold-start.spec.ts`, `failures.spec.ts` |
| `artifacts.spec.ts` | V-015.4: the secret sweep over the extension's own storage — every object store of every IndexedDB database plus all of `chrome.storage.local`, not just the session under test (`metrics.mjs` re-pointed, patterns verbatim) — and the build guard on the shipped bundle. | `metrics.mjs` |

Every refusal is checked against **the fixture app's own request log**, because that is the only
evidence that a guard ran before dispatch rather than after. The executor tab's page load and the
SPA's background polling are not the tool's request and are filtered out, not counted. Every
"nothing reached the target" assertion is followed by a call that *is* allowed, over the same host
and the same log: without that control, a zero also passes for a host that quietly detached.

## Teardown

No spec cleans up in a `finally`. A Playwright **timeout** abandons the test body, so a `finally`
there never runs — and the fixture app, the relay and the bridge outlive the run, after which the
next run dies on its "port is free" wait. Instead every process, browser and temp directory started
by `harness.ts` registers a teardown, and each spec runs `test.afterEach(stopEverything)`, which
Playwright runs whether the body passed, failed or timed out.

The children are spawned `detached`, and teardown kills the process **group** (`process.kill(-pid)`,
escalating to `SIGKILL` after 2 s). `tsx` runs the script in a subprocess of its own, so killing the
direct child reaps the wrapper and leaves the process actually holding the port running.

## The build guard, and why it is not a grep for `new Function`

V-015.4 asks for a grep for `new Function` in the worker bundle. That string is not in the bundle
even when the code is: esbuild minifies `new Function("")` to `Function("")`, and zod reaches the
constructor through an alias that minifies the same way. So `artifacts.spec.ts` looks for the
constructor being **called**, and allows exactly one site — zod's own JIT probe, which is
try/caught and identified by the `Cloudflare` marker beside it. Anything else fails.

Worth knowing: the extension now sets `z.config({ jitless: true })` (`zod-config.ts`), so the
probe never runs; without it zod's
own comment says a strict CSP reports the caught throw as a `securitypolicyviolation`. Harmless
today, visible to a Web Store reviewer.

## Not covered, and why

- **HAR import through the redaction gate** and **recipe export/import round-tripping** —
  `har.ts` and `RecipeStore.exportRecipe/importFiles` exist, but neither has a UI or an entry on
  the extension's `__douze` surface, so nothing outside the extension can start one. Unit-covered
  in `packages/extension/src/har.test.ts` and `recipes.test.ts`. Add a spec here the moment
  T-015.5's file picker lands.
- **A capture carrying a JWT refused by the write gate** (V-015.1) — reachable only through HAR
  import: capture-time redaction replaces the value first, so the gate never fires on the recorded
  path. `store.test.ts` covers the gate directly, and `artifacts.spec.ts` proves the redaction it
  depends on.
- **Doctor runs and drift classification** — the Doctor Run was deleted with the daemon, and
  nothing replaced it: no scheduled replay, no five-way classification, no schema-widening patch,
  no webhook. `DriftStatus` went out of `@douze/shared` with this round, because it had no producer
  and no consumer left. `guards.spec.ts` keeps the half that survived: a tool degraded by a missing
  fixture, announcing itself in its description and refusing before dispatch. `FixtureApp.set()`
  still flips `widenResponse`, `breakResponse`, `sessionValid` and `delayMs` for whatever
  re-implements the rest.
- **The deployed relay** (V-015.2's second half) — `relay.spec.ts` runs against a local
  `startRelay`. Pointing it at a deployed one is a `RelayServer` swap and credentials this suite
  does not hold.
- **Live targets** — `live/openfort.mjs` is still gone. `LIVE_PROFILE` in `harness.ts` is the seam:
  `DOUZE_E2E_PROFILE` points at a Helium profile signed in once by hand. Phase 0's C-1 needs a
  script here; it no longer needs a daemon.

## Pieces

`harness.ts` — `launchHelium` and `FixtureApp` as before, plus: `RelayServer` and `spawnBridge`
(both pipes as real processes, because e2e is not a workspace package and cannot import them),
`HttpMcp` and `McpClient` (the two client shapes), `FakeHost` (a host speaking the attachment
protocol *and* frames an honest one never sends — `@douze/mcp-host` refuses a call for a tool it
never listed, so nothing else can reach `checkPolicy`), and `seedRecipe` / `pairRelay` / `redial`
for putting state into the extension.

Two of those are working around things that are not built yet, and should be revisited:

- `pairRelay` writes `attach:relay` straight into extension storage after calling the relay's own
  `POST /register` — the same call the connect page's button now makes (`douze:connect:start`).
  The helper exists so a spec does not have to drive the page's UI to get an endpoint.
- `redial` sends `douze:connect:pair` to tick the attachment manager on demand, because its own
  trigger is a `chrome.alarms` tick with a 30-second floor. An empty code means "no bridge", so it
  is a tick; a real code is the pairing itself, which is how `bridge.spec.ts` pairs.

`global-setup.ts` builds the extension with the fixture origin baked in. `eval/agent-selection.mjs`
scores agent tool-selection against `packages/studio/src/eval/` and never touched a daemon.
