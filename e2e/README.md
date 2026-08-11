# e2e

`@douze/douzed` and `@douze/cli` were deleted in WO-015 T-015.13. Every Playwright spec in this
directory booted one of them through `Harness.Douzed` or `spawnMcp`, so every one of them was
deleted with the daemon rather than left failing. **Writing the replacement is T-015.14.** This
file is the requirements it inherits, so the next agent restores coverage rather than guessing at
what was lost.

## What is still here

| Path | Why it survived |
|---|---|
| `harness.ts` | `launchHelium`, `FixtureApp`, `McpClient` and `waitFor` are all daemon-free. Only `Douzed` and `spawnMcp` were cut. |
| `global-setup.ts` | Builds the extension with the fixture origin baked into `host_permissions`. Still exactly right — `chrome.permissions.request` needs a user gesture Playwright cannot supply. |
| `eval/agent-selection.mjs` | Scores real agent tool-selection against `packages/studio/src/eval/`. Never touched a daemon. |
| `../fixtures/` | The target app. Unchanged, and the target for the new harness. |

## What was deleted

All of `capture/`, `connector/`, `daemon/`, `drift/`, `eject/`, `relay/`, `remote/`, `runtime/`,
`studio/` and `verification/` — 24 spec files. Also `live/openfort.mjs` (spawned
`packages/douzed/src/bin.ts` and `packages/cli/src/bin.ts`) and `metrics.mjs`.

`remote/connector.spec.ts` was doubly dead: it spoke the WO-014 `RemoteDaemonMessage` /
`RemoteRelayMessage` frames, which T-015.13 also deleted from `@douze/shared`. The attachment
protocol that replaced them lives in `@douze/mcp-host` and is unit-tested there and in
`packages/relay/src/relay.test.ts`.

## What the replacement must cover

The old suite is in git history (`git show HEAD~1:e2e/...`); these are the assertions that must
survive the port, not a wish list.

1. **Capture → review → recipe, with no daemon on the machine** (V-015.1). Record on the fixture
   app, infer, approve, and read the recipe back out of extension storage. A capture carrying a
   JWT must be refused by the write gate. Export then re-import must round-trip byte-identically.
   Replaces `capture/session-capture.spec.ts`, `capture/annotation.spec.ts`,
   `capture/provenance.spec.ts`, `studio/review.spec.ts`.
2. **Execution and guards** (V-015.2). A fake connector speaking streamable-HTTP MCP completes
   list + read against the relay with no daemon anywhere; a write is refused until opted in; a
   destructive call is refused whatever it sends. Replaces `relay/execution.spec.ts`,
   `relay/guards.spec.ts`, `remote/connector.spec.ts`.
3. **The bridge at full trust** (V-015.3). `McpClient` in `harness.ts` is the client for this: a
   real stdio session lists and calls tools, a destructive tool succeeds with `confirm: true` and
   is refused without it, and an unpaired bridge is refused outright. Replaces
   `connector/claude-code.spec.ts`, `connector/desktop.spec.ts`, `connector/cold-start.spec.ts`,
   `connector/failures.spec.ts`.
4. **Drift and degradation.** A widened response, a broken response, and an expired session must
   each produce the documented `RelayErrorCode` and a tool description that announces itself as
   degraded. `FixtureApp.set()` still flips every control these need (`sessionValid`,
   `widenResponse`, `breakResponse`, `delayMs`, `pageStateAuth`). Replaces
   `drift/degradation.spec.ts`, `drift/doctor.spec.ts`, `runtime/surface.spec.ts`.
5. **HAR import through the redaction gate.** Replaces `daemon/har-import.spec.ts`.

## The secret sweep (was `metrics.mjs`)

V-015.4 requires it and it has no home right now. It walked `DOUZE_HOME` — a filesystem that no
longer exists — so it must be re-pointed at extension storage (IndexedDB plus
`chrome.storage.local`), read out through the service worker rather than off disk. Its patterns,
which are worth keeping verbatim:

```js
const PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'JWT'],
  [/\b(sk|pk|rk)_(test|live|prod)?_?[A-Za-z0-9]{16,}\b/, 'prefixed key'],
  [/s3ssion-fixture-value/, 'fixture session cookie'],
  [/page-state-bearer-token-value/, 'fixture page-state token'],
  [/hunter2/, 'fixture password'],
]
```

The same script also measured PRD 1.5's relay overhead (target: under 150 ms over a direct
in-page fetch) and trimmed result size (target: under 2 KB) by calling douzed's `/relay/...`
route. Both now have to be measured through the relay or the bridge instead.

V-015.4 additionally wants a build guard the old suite never had: grep the built worker bundle
for `new Function`, because a bundler config that forces Node conditions silently swaps ajv back
in.

## Live targets

`live/openfort.mjs` drove a real signed-in dashboard end to end and is gone. `LIVE_PROFILE` in
`harness.ts` is the seam it used — `DOUZE_E2E_PROFILE` points at a Helium profile signed in once
by hand, and `launchHelium(EXTENSION, { profileDir: LIVE_PROFILE })` reuses it. Phase 0's C-1
still needs a script here; it no longer needs a daemon.
