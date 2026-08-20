# End-to-end tests

The suite drives the unpacked extension in Helium against the fixture dashboard and starts real
relay and bridge processes.

```sh
pnpm verify:e2e # release gate: the nine specs below
pnpm e2e        # every Playwright spec; currently the same set
```

Requirements:

- macOS;
- `/Applications/Helium.app`;
- one Playwright worker (new headless; `DOUZE_HEADED=1` to watch it run);
- the fixture port available (`4180` by default).

Set `DOUZE_FIXTURE_ORIGIN` to move the fixture. `global-setup.ts` passes that origin to the extension
build as `DOUZE_TEST_ORIGIN`, which writes it into test-only `host_permissions`.

## Specs

| Spec | Contract |
|---|---|
| `journey.spec.ts` | Record a signed-in dashboard, review tools, persist the recipe, and call it through the relay. |
| `relay.spec.ts` | List cached tools with Chrome closed and serve a parked call after reconnection. |
| `guards.spec.ts` | Enforce remote write, destructive, degraded, and result-secret policy before dispatch. |
| `bridge.spec.ts` | Reject an unpaired bridge, pair it, and enforce destructive confirmation over stdio MCP. |
| `artifacts.spec.ts` | Sweep extension storage for secrets and inspect the shipped bundle. |
| `review-consent.spec.ts` | Render the fixed-token consent panel and verify long content does not overflow. |
| `document.spec.ts` | Reduce a document to bounded text and links in a real DOM: root choice, markup exclusion, link resolution, and the size budget. |
| `recording-completeness.spec.ts` | Record a page-rendered search, ignore a second tab, keep the last request, and replay the inferred read tool with a new term. |
| `navigation.spec.ts` | Record a form submit that replaces the document, ignore the session's own reload, and replay the inferred read tool through the server's redirect. |

Refusal tests inspect the fixture server's request log and then make an allowed control call through
the same host. This distinguishes a policy refusal from a detached or broken transport.

## Harness

`harness.ts` owns every process, browser, and temporary directory created by a spec. Each spec calls
`test.afterEach(stopEverything)`. Child processes are detached and teardown kills the process group,
escalating to `SIGKILL` after two seconds, so `tsx` grandchildren do not retain fixture ports after a
failure or timeout.

`global-setup.ts` builds the test extension. `eval/agent-selection.mjs` evaluates tool selection but
is not part of the Playwright release gate.

Not covered end to end: deployed relay infrastructure, live third-party targets, HAR/recipe
import-export UI, and automatic drift detection. Import/export paths have unit coverage; automatic
drift detection is not implemented.
