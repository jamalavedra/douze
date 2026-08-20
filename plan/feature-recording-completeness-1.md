---
goal: Record a page-rendered read (a soft-navigation fetch answered with HTML) as a replayable read tool, and stop losing the last requests of a session
version: 2.0
date_created: 2026-08-20
last_updated: 2026-08-20
owner: Douze maintainers
status: 'Implemented'
tags: [feature, capture, inference, browser, reliability, privacy]
---

# Introduction

![Status: Implemented](https://img.shields.io/badge/status-Implemented-green)

Recording a Reddit search produced no tool. Version 1 of this plan assumed the search was a
main-frame navigation dropped by `worthWatching` (`packages/extension/src/oracle.ts:68`) and
designed a main-frame observer, a URL poller, an inactive-tab execution mode, an action ledger and
persisted-GraphQL support around that assumption. Reproducing the flow in Helium showed a different
mechanism, and this version is rewritten around what was observed.

## 0. Evidence

Reproduced on 2026-08-20 against `https://www.reddit.com/` with OpenCLI driving Helium.

| Observation | Value |
|---|---|
| Search control | `<form method="get" action="/search/?q=">` |
| After submit | `location.href` = `/search/?q=wallet`; `performance.getEntriesByType('navigation')[0].name` still `https://www.reddit.com/`; document age 31 s — a **soft navigation** |
| How results arrived | `fetch https://www.reddit.com/search/?q=wallet&screen_view_count=1&ext-referrer=DIRECT`, status 200, `content-type: text/html`, body begins `<!-- hybrid routing page -->` |
| Results in DOM | 6 post units inside `<main>`, ~2 000 chars of text, 38 links; nothing loads on scroll |
| Other traffic from the search | `POST /svc/shreddit/events` (`text/plain`), `GET /svc/shreddit/styling-overrides/?v=1` (`application/json`), a recaptcha token |
| Opening a result | Also a soft navigation; fires `POST /svc/shreddit/graphql` with body `{"operation":"UserCommunityAchievements","variables":{…},"csrf_token":"…"}` and no `query` |
| Plain replay | `fetch('/search/?q=wallet', {credentials:'include'})` with no other headers → 200, full `<!DOCTYPE html>` page (582 511 chars); `DOMParser` + `main` + `script/style` removed → 1 912 chars of text and 38 links, starting with the result titles |

Consequences for the design:

- The MAIN-world interceptor already captures the search with its full HTML body (`TEXTUAL` in
  `interceptor.ts:259` admits `text/html`). `emit()` drops it at `admits()` because `text/html` is
  not in `ALLOWED_CONTENT` (`packages/shared/src/capture.ts:158`) and logs
  `Douze skipped GET …/search/ (text/html)`. No main-frame request is involved.
- Replay needs no new execution mode: the existing fetch path returns the page with the user's
  cookies and no special headers. The only missing step is turning HTML into something an assistant
  can read.
- The oracle also sees this request but its draft has no body and `text/html`, so `admits()` drops
  it; there is no duplicate to reconcile.
- What a recording of that session retains today is `styling-overrides` (a junk read) and the
  telemetry POSTs (`text/plain` is allowed). Noise filtering is a separate follow-up, not this plan.
- Reddit's GraphQL shape is real but fires from background UI, not from the search. Persisted
  operations are deferred (see §3).

## 1. Requirements & Constraints

- **REQ-001**: A MAIN-world `GET` fetch/XHR whose response is `text/html` becomes an exchange whose `response_body` is a bounded semantic snapshot `{ url, title, text, links[] }` — never raw HTML.
- **REQ-002**: One extractor, `snapshotDocument(html, baseUrl)`, produces the snapshot at capture and at replay. It is a self-contained function (no references outside its own body) so `chrome.scripting.executeScript({ func })` can run it in a tab.
- **REQ-003**: The snapshot selects `main, [role="main"]`, falling back to `body`; removes `script`, `style`, `template`, `noscript`, and the navigation landmarks `nav`, `[role="navigation"]`, `aside` (found on Wikipedia: the language sidebar sits inside `main`); normalizes whitespace in `textContent`; collects `a[href]` in DOM order, resolved against `baseUrl`, `http:`/`https:` only, deduplicated by resolved URL.
- **REQ-004**: The serialized snapshot fits the existing tool-result cap (`MAX_RESULT_BYTES`, 32 KiB in `guards.ts:34`): total JSON length ≤ 24 576 UTF-16 code units, enforced by dropping links from the end first, then truncating text. Per-link caps: label 120, URL 512 code units.
- **REQ-005**: Raw HTML is never persisted. It exists in the worker only between ingest and extraction, and in the executor tab only between `issueRequest` and extraction.
- **REQ-006**: Inference turns document exchanges into read candidates grouped by method and pathname with the existing REST helpers (path params, query params). Document exchanges never share a group with JSON exchanges on the same path. `primary_payload_path` is `$` for a document candidate.
- **REQ-007**: Replay uses the existing fetch path. When the reply's `content-type` is `text/html`, the relay runs `snapshotDocument` in the same executor tab and returns the snapshot as the body. Origin checks (`landedOrigin`, `isLoginRedirect`) are unchanged.
- **REQ-008**: No recipe schema change. `RequestContract` and `RelayRequest` are untouched; existing recipes need no migration.
- **REQ-009**: Scope the `douze:capture` message branch to `recording.tabId`. The oracle is already scoped (`background.ts:1116`).
- **REQ-010**: Stopping a session first flushes the bridge buffer, drains the reconciler, and awaits the write queue, so a request completed just before Done is retained.
- **REQ-011**: No model call. No Reddit, hostname, pathname or product-specific rule.
- **SEC-001**: The snapshot passes through `redactBody` in `finalize` and through `CaptureStore.appendExchange`'s gate like every other body. Link URLs are judged part by part as URLs already are.
- **SEC-002**: Page prose is not scanned for tokens embedded inside sentences — `looksLikeCredential` judges whole strings (`redact.ts:376`). This is the same exposure `text/plain` responses already have today; the plan does not claim otherwise. RISK-001 records it.
- **SEC-003**: Replay never opens a visible tab and never navigates a tab the user has open: it is the existing `findTab`/`openExecutorTab` path with a fetch, not a navigation.
- **CON-001**: `interceptor.js` and `bridge.js` must keep importing nothing at runtime (`smoke.mjs`). The extractor therefore lives in a worker-side module and reaches a page only through `executeScript`.
- **CON-002**: The service worker has no `DOMParser`; extraction always runs in a tab.
- **CON-003**: `shouldCapture` is unchanged. HAR import stays HTTP-only and gets no document path.
- **CON-004**: No new permission. `scripting` and the granted host permission already cover `executeScript` in the recorded and executor tabs.
- **GUD-001**: Reuse `sequence()`, `finalize`, `CaptureStore`, `groupEndpoints`, `queryParams`, `inferSchema`, `findTab`, `openExecutorTab`, `issueRequest`.

## 2. Implementation Steps

### Implementation Phase 1 — stop losing the tail of a session

- GOAL-001: Two small, independent reliability fixes that the Reddit recording also hit.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `packages/extension/src/background.ts`, in the `douze:capture` branch, return before `ingest` unless `tabId === recording.tabId`. Add a `background.test.ts` case: two tabs on the granted origin, only the recorded one changes the count and the store. | ✅ | 2026-08-20 |
| TASK-002 | In `packages/extension/src/pipeline.ts`, add `Reconciler.flush(): ExchangeDraft[]` returning every deferred draft that has no matching credit, clearing `deferred` and `credits`. Remove the `ponytail:` note above `stopSession`. Unit test in `pipeline.test.ts`. | ✅ | 2026-08-20 |
| TASK-003 | In `packages/extension/src/messages.ts`, add the worker→content command `{ type: 'douze:flush' }`. In `bridge.ts`, on that message cancel the pending batch timer, run `flush()` until `BUFFER` is empty, then reply. In `stopSession()`: `await chrome.tabs.sendMessage(recording.tabId, { type: 'douze:flush' }).catch(() => {})` (the content script may be gone), then `for (const draft of reconciler.flush()) emit(draft)`, then the existing `sequence(() => captures.stopSession(...))`. | ✅ | 2026-08-20 |

### Implementation Phase 2 — document reads

- GOAL-002: The Reddit search — and every "hybrid routing" site that fetches HTML for a route (Next.js, Turbo, htmx, Hotwire) — records and replays as a read tool.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add `packages/extension/src/document.ts` exporting `snapshotDocument(html: string, baseUrl: string): DocumentSnapshot` per REQ-002/003/004, and the `DocumentSnapshot` type `{ url: string; title: string; text: string; links: { label: string; url: string }[] }`. Self-contained: no imports used at runtime, no outer identifiers. `url` is `baseUrl`; `title` is `document.title` of the parsed document. | ✅ | 2026-08-20 |
| TASK-005 | Add `packages/extension/src/document.ts`'s `isDocumentDraft(draft)`: `method` is `GET`, `response_content_type` starts with `text/html`, `response_body` is a non-empty string, `source` is `main_world`. In `background.ts` `ingest`, before `route()`: when the draft is a document, `void snapshotInTab(tabId, draft)` which runs `chrome.scripting.executeScript({ target: { tabId }, func: snapshotDocument, args: [html, url] })`, replaces `response_body` with the result, sets `response_size` to the serialized snapshot length, and then calls `route()`. On failure (tab navigated, script refused) log `console.debug` with method, origin and pathname only — same courtesy as the existing skip line — and drop. | ✅ | 2026-08-20 |
| TASK-006 | In `background.ts` `emit`, admit a draft whose `response_body` is a `DocumentSnapshot` (check shape, not content type) without calling `admits()`; everything else keeps the current `admits()` path. `shouldCapture` is untouched (CON-003). Add a `background.test.ts` case: a `text/html` response event produces one stored exchange whose body is the snapshot and never the HTML string; a `text/html` event for which `executeScript` rejects stores nothing. | ✅ | 2026-08-20 |
| TASK-007 | In `packages/studio/src/inference/engine.ts`, add `isDocumentExchange(e)`: `response_content_type` starts with `text/html` and `response_body` has string `url`, `title`, `text` and array `links`. Split `rest` into `documents` and `json` before grouping; group documents with `groupEndpoints` separately so they never join a JSON group. For a document group, build the candidate through `restCandidate` with `payloadPath` forced to `$` and `pagination` undefined. Output schema comes from `inferSchema` over the snapshots. | ✅ | 2026-08-20 |
| TASK-008 | In `packages/studio/src/inference.test.ts`, add fixtures: two `GET /search/?q=…` exchanges with snapshot bodies → one read candidate with a `q` query parameter and the snapshot output schema; one JSON and one document exchange on the same path → two candidates, not one. | ✅ | 2026-08-20 |
| TASK-009 | In `packages/extension/src/relay.ts`, after `issueRequest` returns and before `parseBody`: if `result.headers['content-type']` starts with `text/html` and `result.status` is `< 400`, run `executeScript({ target: { tabId }, func: snapshotDocument, args: [result.body, result.url] })` in the same executor tab and use the returned snapshot as the body. The `landedOrigin` check runs before this, on `result.url`, exactly as today. A redirect to a login page is still reported by `isLoginRedirect`. | ✅ | 2026-08-20 |
| TASK-010 | In `packages/extension/src/relay.test.ts`, stub `executeScript` so a call with `func === snapshotDocument` returns a fixed snapshot: assert a `text/html` reply yields the snapshot body, a JSON reply never invokes the extractor, a cross-origin `result.url` is refused before extraction, and the ephemeral executor tab is still removed in `finally`. | ✅ | 2026-08-20 |
| TASK-011 | Add `e2e/document.spec.ts`: open a fixture page, `page.evaluate` the source of `snapshotDocument` against inline HTML strings, and assert: `main` preferred over `body`; `script`/`style` text excluded; whitespace normalized; links in DOM order, deduplicated, relative URLs resolved, `javascript:`/`mailto:` dropped; total-length budget honoured by dropping links first then text. This is the extractor's only DOM test (the package has no jsdom by design). | ✅ | 2026-08-20 |

### Implementation Phase 3 — end-to-end proof

- GOAL-003: The recorder-to-tool-to-replay path works for a page-rendered read with no site-specific rule.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-012 | In `fixtures/server.ts`, add `GET /search/?q=` returning `text/html` with a `<main>` holding two result links and a `<script>` block that must not appear in the snapshot. In `servePage`, add a search form whose submit handler calls `fetch('/search/?q=' + q)` and swaps `<main>` — the soft-navigation shape observed on Reddit. No Reddit naming. | ✅ | 2026-08-20 |
| TASK-013 | Add `e2e/recording-completeness.spec.ts`: record a search on the fixture page, press Done immediately, review, approve the inferred document tool, call it through MCP with a different `q`, and assert the result's `links` contain the two fixture links and `text` excludes the script body. Assert the stored exchange body is a snapshot, not HTML. | ✅ | 2026-08-20 |
| TASK-014 | In the same spec: a second tab on the fixture origin makes a JSON request during the recording and nothing from it is stored (TASK-001); a request completed inside the bridge's 250 ms batch before Done is retained (TASK-003). | ✅ | 2026-08-20 |
| TASK-015 | Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm verify:e2e`. Record the commands and results in the change description. All five must exit `0`. `smoke.mjs` must still find no import in `interceptor.js` or `bridge.js`. | ✅ | 2026-08-20 |
| TASK-017 | Found by TASK-013: `pathSegments` in `packages/studio/src/inference/templating.ts` dropped a trailing slash, so `/search/` was replayed as `/search` (404 on the fixture; a redirect on Reddit, which `issueRequest` refuses). Keep a trailing slash as an empty final segment through templating; unit test in `inference.test.ts`. | ✅ | 2026-08-20 |
| TASK-016 | Verify against the real site in Helium, the same way the failure was found. Build the extension with `DOUZE_TEST_ORIGIN=https://www.reddit.com` (test-only host permission, no prompt), launch Helium with it through the e2e harness, start a session on a `reddit.com` tab, submit a search from the site's own form, press Done, and confirm: (a) the session holds a `GET /search/` exchange whose body is a snapshot, not HTML; (b) review infers a read tool with a `q` parameter; (c) calling that tool with a different `q` returns `links` whose labels are result titles. Record the observed values in the change description. | ✅ | 2026-08-20 |


### Implementation Phase 4 — hard navigations and the HTML content-type family

- GOAL-004: A classic server-rendered application — one whose search or navigation replaces the document — records and replays the same way. Measured on 2026-08-20 against five sites' search flows: Reddit and npm are soft navigations (covered by Phases 1–3); Wikipedia, Stack Overflow and Hacker News replace the document and recorded nothing.

Requirements added:

- **REQ-012**: A user-caused main-frame `GET` navigation in the recorded tab becomes a document exchange: the oracle supplies method, request URL, status and response headers; the snapshot is taken from the loaded document itself with the same extractor. Navigations with no gesture inside `PROVENANCE_WINDOW_MS` — the `startSession` reload, a typed URL, back/forward — are ignored. Sub-frame navigations stay out of scope.
- **REQ-013**: `snapshotDocument(html: string | null, baseUrl)`: `null` means "the document this runs in". It must not mutate the live page (serialize `document.documentElement.outerHTML` and parse that, so one code path serves both).
- **REQ-014**: The bridge sends gestures immediately rather than in the 250 ms batch: a form submit unloads the page before the batch timer fires, and the navigation that follows must find its gesture already in the worker.
- **REQ-015**: A document exchange's `url` is the request URL (what replay re-issues); the snapshot's `url` is where the server landed, redirects included.
- **REQ-016**: Replay follows redirects when the request carries nothing but cookies — no credential-shaped header, no page-state or literal header contribution — because cookies do not cross origins and the existing `landedOrigin` check still refuses a cross-origin landing. A request carrying a custom credential header keeps `redirect: 'error'`. A server-rendered search commonly 302s to a canonical result page.
- **REQ-017**: "HTML" is the content-type family, not the literal `text/html`: `text/vnd.turbo-stream.html`, `text/vnd.reddit.partial+html` and any `text/*html*` are documents. One regex, used at capture, inference and replay.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-018 | `packages/extension/src/document.ts`: `snapshotDocument(html: string \| null, baseUrl)` per REQ-013, still self-contained. Export `HTML_TYPE = /^text\/[^;]*html/i` and use it in `isDocumentDraft`. | ✅ | 2026-08-20 |
| TASK-019 | `packages/extension/src/oracle.ts`: a main-frame `GET` in a recording tab is no longer dropped by `worthWatching`; on `onCompleted` it is reported through a new handler `onNavigation({ tabId, url (request URL), finalUrl (details.url), status, responseHeaders, startedAt, durationMs })` instead of `onObserved`. Sub-frame `GET` stays excluded; navigation `POST` keeps its current headers-only path. Update `oracle.test.ts`. | ✅ | 2026-08-20 |
| TASK-020 | `packages/extension/src/background.ts`: implement `onNavigation`. Gate: `recording && tabId === recording.tabId`; `attribute(startedAt, lastGesture.get(tabId))` must yield provenance, else ignore (REQ-012). Wait for `chrome.tabs.onUpdated` `status === 'complete'` for that tab (15 s cap, like `openExecutorTab`), then `executeScript({ target: { tabId }, func: snapshotDocument, args: [null, finalUrl] })`, build an `ExchangeDraft` (`method: 'GET'`, `url` = request URL, the real status/headers, `response_content_type` from the headers, `response_body` = snapshot, `source: 'web_request'`, `body_missing: false`, the gesture) and `emit()` it (no reconciler: nothing else observes a navigation). Failures log method + origin + path only. Tests in `background.test.ts`: navigation after a gesture → one snapshot exchange with the request URL; navigation with no gesture → nothing; failed `executeScript` → nothing. | ✅ | 2026-08-20 |
| TASK-021 | `packages/extension/src/bridge.ts`: `report()` sends the gesture in its own `douze:capture` message immediately (REQ-014); request/response events keep batching. Bridge stays import-free. | ✅ | 2026-08-20 |
| TASK-022 | `packages/extension/src/relay.ts`: compute `redirect` per REQ-016 in `executeRelay` (cookie-only ⇒ `'follow'`, else `'error'`) and pass it into `issueRequest` as an argument; the `landedOrigin` check is unchanged and still runs on `result.url`. Replace the `startsWith('text/html')` checks with `HTML_TYPE`. Tests in `relay.test.ts`: cookie-only request follows a same-origin redirect and snapshots the landing page; a request with an `authorization` contribution still uses `'error'`; a cross-origin landing is still refused. | ✅ | 2026-08-20 |
| TASK-023 | `packages/studio/src/inference/engine.ts`: `isDocumentExchange` uses the same family regex (studio cannot import the extension module — define the regex in `@douze/shared` `capture.ts` as `isHtmlContentType()` and use it from both packages). Test: a `text/vnd.turbo-stream.html` snapshot is a document candidate. | ✅ | 2026-08-20 |
| TASK-024 | `fixtures/server.ts`: a plain `<form method="get" action="/find/">` on the page (no JavaScript) whose handler answers `302 Location: /results/<term>/`, and `GET /results/<term>/` returns the same HTML shape as `/search/`. `e2e/navigation.spec.ts`: record, submit that form (a real navigation), Done, assert one stored `GET /find/?q=…` snapshot exchange whose `url` field inside the snapshot is `/results/…/`; review; call with a new term; assert the replay followed the redirect and returned the links. Assert the `startSession` reload produced no document exchange. Add the spec to `verify:e2e`. | ✅ | 2026-08-20 |
| TASK-026 | Found by TASK-024: Chrome re-fires `onBeforeRequest` for a redirect's next leg under the same request id, and the oracle overwrote the request URL with the landing URL. Keep the first leg (`oracle.ts`); covered in `oracle.test.ts`. `issueRequest` collapsed to one `InjectedCall` argument (≤5 positional parameters). | ✅ | 2026-08-20 |
| TASK-025 | Live verification in Helium against `https://en.wikipedia.org` (signed-out, classic hard navigation, `input[name="search"]`, the form 302s to the article for an exact title): record a search, Done, confirm a snapshot exchange, infer, call with another term, get the article's text and links. Observed: stored `GET /w/index.php?search=Wallet&title=Special:Search` with snapshot `url` `/wiki/Wallet`; candidate `list_indexphps` (`search`, `title` required); `wikipedia_list_indexphps` called with `search: Ledger` → 200, snapshot `url` `/wiki/Ledger`, article text and links. Reddit was verified the same way earlier (`reddit_list_searches`, `q: ledger` → live results), but its spec was removed: reddit.com answers the verification host with "You've been blocked by network security" and a JS challenge, so it cannot be re-run where browser tests are allowed. Wikipedia is the live check. | ✅ | 2026-08-20 |

## 3. Deferred, with the evidence for each

- **DEF-001 — hard main-frame navigations.** Promoted to Phase 4 after the five-site survey showed it is half the sample.
- **DEF-002 — persisted GraphQL operations.** Reddit's body is `{ operation, variables, csrf_token }` with no `query`. Real, but it fired from background UI, not from the search, and the envelope carries a CSRF token that a template would have to redact and refill from page state. Revisit when a recorded *user action* depends on one; support `operation` and Apollo APQ (`extensions.persistedQuery.sha256Hash`) only — `id` is a guess that collides with ordinary REST bodies.
- **DEF-003 — unresolved-action ledger.** Every click would become a row and most rows would be `no_observation` with no remedy. Revisit if users ask "why did this click produce nothing" after this plan ships. If needed, keep gestures in worker memory and write an `unresolved[]` onto the `CaptureSession` row at stop — no new object store.
- **DEF-004 — noise.** The same recording retains `styling-overrides` and telemetry POSTs as candidates. A separate, small plan.

## 4. Alternatives

- **ALT-001**: Observe main-frame GET navigations via `webRequest` (v1 TASK-009). Rejected for this incident: the search is a fetch, not a navigation; the observer would not have fired.
- **ALT-002**: Poll `location.href` and snapshot the live DOM on change (v1 REQ-006). Rejected: catches the Reddit case only by timing luck, and doubles candidates on every SPA whose routes also call an API.
- **ALT-003**: A new `execution: 'document'` mode that navigates an inactive tab (v1 TASK-012). Rejected: a plain cookie-bearing fetch returns the page; a navigation would also run the site's scripts and their side effects.
- **ALT-004**: Persist raw HTML and extract at review time. Rejected: 582 KB per search in IndexedDB, the review page would hold it in memory, and the privacy surface is the whole page rather than its text.
- **ALT-005**: Extract in the MAIN-world interceptor. Rejected: the interceptor cannot import the extractor (CON-001) and would need a second copy.
- **ALT-006**: Extract in a `chrome.offscreen` document. Viable and tab-independent, but needs the `offscreen` permission and a new entry. The upgrade path if `executeScript` into the recorded tab proves flaky (RISK-003).
- **ALT-007**: Import curated site adapters, guess endpoints with a model, or probe `.json`/`/api` variants. Rejected as in v1.

## 5. Dependencies

- **DEP-001**: `chrome.scripting.executeScript` with the already-granted host permission, in the recorded tab and in the executor tab.
- **DEP-002**: Existing `@douze/shared` redaction and `CaptureStore` gate.
- **DEP-003**: Existing Studio REST inference helpers.
- **DEP-004**: Existing Playwright harness and fixture server.
- **DEP-005**: No new runtime, development dependency, or permission.

## 6. Files

- **FILE-001**: `packages/extension/src/document.ts` — `snapshotDocument`, `DocumentSnapshot`, `isDocumentDraft`.
- **FILE-002**: `packages/extension/src/background.ts` — tab gate, document extraction before `route()`, admission in `emit`, stop-time flush.
- **FILE-003**: `packages/extension/src/pipeline.ts` — `Reconciler.flush()`.
- **FILE-004**: `packages/extension/src/messages.ts`, `packages/extension/src/bridge.ts` — `douze:flush`.
- **FILE-005**: `packages/extension/src/relay.ts` — snapshot a `text/html` reply in the executor tab.
- **FILE-006**: `packages/studio/src/inference/engine.ts` — document candidates.
- **FILE-007**: `packages/extension/src/background.test.ts`, `pipeline.test.ts`, `relay.test.ts`, `packages/studio/src/inference.test.ts` — unit coverage named above.
- **FILE-008**: `fixtures/server.ts`, `e2e/document.spec.ts`, `e2e/recording-completeness.spec.ts`.

## 7. Testing

- **TEST-001**: Extractor behaviour in a real DOM (TASK-011).
- **TEST-002**: A `text/html` fetch response is stored as a snapshot; raw HTML never reaches the store; extraction failure stores nothing (TASK-006).
- **TEST-003**: Document and JSON exchanges on one path produce two candidates; a document candidate has `primary_payload_path` `$` and a `q` parameter (TASK-008).
- **TEST-004**: Replay snapshots `text/html`, leaves JSON alone, keeps origin refusal ahead of extraction, still closes the ephemeral tab (TASK-010).
- **TEST-005**: Second same-origin tab is ignored; bridge-buffered request survives an immediate Done (TASK-001, TASK-003, TASK-014).
- **TEST-006**: End-to-end search → tool → MCP call returns the fixture links (TASK-013).
- **TEST-007**: Privacy: a link URL carrying `?token=…` in the snapshot is redacted by the existing URL-part rule; a JWT as a whole link label is replaced. Documented non-goal: a token inside a sentence of `text` passes (SEC-002).
- **TEST-008**: Full verification (TASK-015).

## 8. Risks & Assumptions

- **RISK-001**: Page text can contain private account data and embedded tokens the whole-string rule does not see. Same class as `text/plain` today; review approval and local-only storage remain the controls. A tokenised scan of `text` is the follow-up if a real recording shows a leak.
- **RISK-002**: A site may return a different document to a plain fetch than to its router's fetch (different `accept` header). Reddit does not; the snapshot of the full page still starts with the results. If a site does, inference's static `headers` is the place to carry the observed `accept`, which inference does not emit today.
- **RISK-003**: `executeScript` into the recorded tab fails if the tab navigated between response and injection. A soft-navigation site keeps its document; a hard-navigation site is DEF-001 territory anyway. The draft is dropped with a debug line, not stored half-made.
- **RISK-004**: Extraction of a 500 KB page runs on the tab's renderer thread. One `DOMParser` parse per HTML response is the cost; acceptable for a recording session.
- **RISK-005**: The 24 576-code-unit budget can still exceed 32 KiB in UTF-8 for non-Latin pages; `capResult` remains the final guard and labels the truncation.
- **RISK-006**: A login page answers 200 with HTML on some sites; the tool then returns a snapshot of the login page. `isLoginRedirect` covers the redirect case; the 200 case is visible to the caller in `title`/`text` and is not worse than today's JSON error body.
- **ASSUMPTION-001**: Inference's query-parameter helpers already turn `?q=wallet` into a `q` string parameter for a GET group; the document candidate relies on nothing beyond that.
- **ASSUMPTION-002**: `chrome.scripting.executeScript` into the recorded tab is permitted for the whole recording: the origin is granted (content scripts are registered on it) and `scripting` is in the manifest.

## 9. Related Specifications / Further Reading

- `packages/extension/src/interceptor.ts:259` — `TEXTUAL` already admits `text/html` bodies.
- `packages/shared/src/capture.ts:158` — `ALLOWED_CONTENT`, the drop point.
- `packages/extension/src/background.ts:313` — `emit()` and the skip line.
- `packages/extension/src/relay.ts:168` — `issueRequest`, the replay seam.
- `packages/extension/src/guards.ts:34` — `MAX_RESULT_BYTES`.
- `packages/extension/vite.config.ts:24` — why page scripts import nothing.
