// First, and before any schema is built: see the file for why.
import './zod-config.js'
import { MAX_NOTE_CHARS, NOISE_HOSTS, type CaptureSession, type Exchange, type NoiseConfig } from '@douze/shared'
import type {
  CaptureBatch,
  ConnectCommand,
  ConnectState,
  DataCommand,
  DataState,
  GestureEvent,
  PageEvent,
  PopupCommand,
  PopupStatus,
  RequestEvent,
  ReviewCommand,
  ReviewSaved,
  ReviewState,
  SiteTool,
} from './messages.js'
import {
  BRIDGE_KEY,
  EXPOSE_KEY,
  RELAY_KEY,
  clearCalls,
  recentCalls,
  startAttachments,
  type BridgePairing,
  type ExposeLists,
  type RelayPairing,
} from './attach.js'
import { DebuggerCapture } from './debugger-capture.js'
import { importHar } from './har.js'
import { installOracle } from './oracle.js'
import { RECONCILE_GRACE_MS, Reconciler, admits, decodeBody, finalize, type ExchangeDraft } from './pipeline.js'
import { RecipeStore, type SurfaceTool } from './recipes.js'
import { executeRelay } from './relay.js'
import { ReviewSession } from './review-session.js'
import { CaptureStore } from './store.js'

/**
 * T-001.4 / T-002.2 / T-015.1 — the service worker. It owns session lifecycle, provenance
 * attribution, redaction (in `finalize`), reconciliation across capture paths, and the write into
 * the extension's own `CaptureStore`. There is no daemon and no socket: a capture is a local
 * IndexedDB write, which is why the outbox that buffered exchanges for a stopped daemon is gone.
 *
 * Every listener below is registered synchronously at the top level: a listener added after an
 * `await` silently stops working once Chrome respawns the worker.
 */

const RECONCILE_IDS = ['douze-main', 'douze-bridge']

interface Recording {
  session: CaptureSession
  tabId: number
  /** Next position to assign; Annotation Spans index into the same sequence. */
  position: number
  count: number
  /**
   * Every origin the page actually talked to — usually its API host rather than its own. The
   * popup asks Chrome for permission on these when the session ends, because execution replays
   * inside a tab on the *target* origin and cannot touch one that was never granted.
   */
  seenOrigins: string[]
}

let recording: Recording | null = null
/** AC-CAP-004.3 — the user's additions to the bundled noise list. */
let noiseHosts: string[] = []
/** AC-CAP-004.1 / .3 — the bundled list plus those additions; never a copy of the list. */
let noise: NoiseConfig = { hosts: NOISE_HOSTS }
const pendingRequests = new Map<string, { event: RequestEvent; gesture?: GestureEvent }>()
const lastGesture = new Map<number, GestureEvent>()
const reconciler = new Reconciler()

const debuggerCapture = new DebuggerCapture((draft) => emit(draft))

// --- state ----------------------------------------------------------------

async function loadSettings(): Promise<void> {
  const local = await chrome.storage.local.get('noise_hosts')
  noiseHosts = Array.isArray(local['noise_hosts']) ? (local['noise_hosts'] as string[]) : []
  noise = { hosts: [...NOISE_HOSTS, ...noiseHosts] }
}

/**
 * Capture writes run one at a time, in the order the pipeline produced them.
 *
 * `annotate` computes its span from what the store already holds and `stopSession` counts what
 * survived, so either one overtaking an append still in flight would silently mis-report: a note
 * would miss the exchange the user is describing, and `retained` would be short.
 */
let writes: Promise<unknown> = Promise.resolve()
function sequence<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work, work)
  writes = next.catch(() => {})
  return next
}

/** Session state lives in `chrome.storage.session`: module globals die with the worker. */
const hydrated = (async () => {
  await loadSettings()
  const session = await chrome.storage.session.get('recording')
  recording = (session['recording'] as Recording | undefined) ?? null
  await paintBadge()
})()

async function persist(): Promise<void> {
  if (recording) await chrome.storage.session.set({ recording })
  else await chrome.storage.session.remove('recording')
}

/** AC-CAP-001.3 — a live count on the toolbar icon for as long as the session runs. */
async function paintBadge(): Promise<void> {
  painted = recording ? String(recording.count) : ''
  await chrome.action.setBadgeText({ text: painted })
  // The review page's brand blue. This API takes one flat colour, not `light-dark()`.
  await chrome.action.setBadgeBackgroundColor({ color: '#00bce8' })
}
/** The last text handed to `setBadgeText`, so a test can assert what the badge shows. */
let painted = ''

// --- stores ---------------------------------------------------------------

/**
 * The two stores the extension is built on. Opened once per worker and kept: a capture writes to
 * one on every exchange, and `RecipeStore.open` installs the `storage.onChanged` listener that
 * keeps the surface hot.
 */
let stores: Promise<{ captures: CaptureStore; recipes: RecipeStore }> | undefined

const openStores = (): Promise<{ captures: CaptureStore; recipes: RecipeStore }> => {
  stores ??= Promise.all([CaptureStore.open(), RecipeStore.open()]).then(([captures, recipes]) => ({
    captures,
    recipes,
  }))
  return stores
}

// --- the attachment -------------------------------------------------------

/**
 * The Tool Surface, kept synchronously so a `tool.call` never has to await a store to find out
 * whether the tool exists. Replaced wholesale by `RecipeStore.subscribe`, which is the same signal
 * that triggers the `surface.push` to every host.
 */
let liveSurface: readonly SurfaceTool[] = []

/** Notification id → where clicking it should take the user. Rebuilt with the worker. */
const notificationTargets = new Map<string, string>()

const hostnameOf = (origin: string): string => {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}

/** AC-EXE-002.3 — a session that has expired is surfaced with a link to the target's login page. */
function notifyExpired(origin: string, loginUrl: string): void {
  const site = hostnameOf(origin)
  notify(
    `douze-expired-${origin}`,
    `Signed out of ${site}`,
    `You've been signed out of ${site}, so your assistant can't act there. Click to sign in again.`,
    loginUrl,
  )
}

function notify(id: string, title: string, message: string, url?: string): void {
  if (url !== undefined) notificationTargets.set(id, url)
  else notificationTargets.set(id, chrome.runtime.getURL('connect.html'))
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon128.png'),
    title,
    message,
  })
}

/**
 * WO-015 T-015.8/9 — the one attachment client, serving the relay and every local bridge. Started
 * at the top level so its `chrome.alarms` listener is registered before any await, and the alarm
 * itself is recreated on every worker start because an evicted worker keeps no timers.
 */
const attachments = startAttachments({
  surface: () => liveSurface,
  // Never replay through the tab being recorded: the oracle would ingest our own request.
  execute: (request) =>
    executeRelay(request, { notifyExpired, ...(recording === null ? {} : { recordingTabId: recording.tabId }) }),
  notify: (id, title, message) => notify(id, title, message),
})

/**
 * The recipe store is opened at worker start rather than lazily: `RecipeStore.subscribe` is what
 * keeps every attached host's cached surface honest, and a worker that only opened the store on
 * the first capture would serve a stale one for its whole life. Dialling comes after, so the first
 * `surface.push` of a connect is never the empty one.
 */
const dialled = hydrated.then(async () => {
  const { recipes } = await openStores()
  liveSurface = recipes.surface().tools
  recipes.subscribe((state) => {
    liveSurface = state.tools
    // T-015.8 — a recipe change is a `surface.push` on every live attachment.
    attachments.pushSurface()
    void pruneExposed(state.tools)
  })
  await pruneExposed(liveSurface)
  await attachments.tick()
})

/**
 * T-015.9 — `attach:expose` holds qualified tool names, and nothing ever removed one.
 *
 * An exemption says "this tool's results legitimately look like credentials", which is a statement
 * about the tool the user was looking at. Delete recipe `foo` and import a different `foo` later
 * and its `bar` would inherit an exemption nobody granted it — silently, because the name is the
 * whole key. Filtered against the live surface whenever the surface moves, so a name that is not
 * a tool right now is not an exemption right now either. Re-granting is two clicks; a credential
 * released to a relay operator is not recallable.
 */
async function pruneExposed(tools: readonly SurfaceTool[]): Promise<void> {
  const stored = await chrome.storage.local.get(EXPOSE_KEY)
  const expose = stored[EXPOSE_KEY] as Partial<ExposeLists> | undefined
  if (!expose) return
  const live = new Set(tools.map((tool) => tool.qualified_name))
  const kept: ExposeLists = {
    local: (expose.local ?? []).filter((name) => live.has(name)),
    remote: (expose.remote ?? []).filter((name) => live.has(name)),
  }
  if (kept.local.length === (expose.local ?? []).length && kept.remote.length === (expose.remote ?? []).length) {
    return
  }
  await chrome.storage.local.set({ [EXPOSE_KEY]: kept })
  // The manager holds its own copy and only re-reads storage on a tick, so without this the gate
  // would go on exempting a tool that no longer exists until the next alarm.
  await attachments.tick()
}

// --- credentials the page keeps nowhere readable ---------------------------

/**
 * Where an unlocatable credential header waits for a decision.
 *
 * `chrome.storage.session` is memory-backed and dies with the browser, so a value parked here is not
 * at rest and is gone if nobody approves that site. The alternative — persisting every unlocatable
 * credential header automatically — cannot be made safe: no rule separates x.com's public app bearer
 * from somebody's own session token, because both are low-entropy strings in an `authorization`
 * header. So the value is held just long enough for a person to see it on the review page.
 *
 * Approved ones move to `LITERALS_KEY`, keyed by ORIGIN rather than living in the recipe: a skills
 * file then still contains no credential, and export stays safe to hand to somebody.
 */
const PENDING_KEY = 'auth:pending'
export const LITERALS_KEY = 'auth:literals'

type ParkedLiteral = { header: string; value: string; prefix: string }

/** Strips the value out of a draft's hints and parks it, so nothing stored ever carries one. */
async function parkLiteral(draft: ExchangeDraft): Promise<void> {
  const carrying = (draft.credentials ?? []).filter((hint) => hint.value !== undefined && hint.header)
  if (carrying.length === 0) return
  const origin = originOf(draft.url)
  const stored = await chrome.storage.session.get(PENDING_KEY)
  const pending = (stored[PENDING_KEY] as Record<string, ParkedLiteral[]> | undefined) ?? {}
  const forOrigin = pending[origin] ?? []
  for (const hint of carrying) {
    if (!forOrigin.some((entry) => entry.header === hint.header)) {
      forOrigin.push({ header: hint.header as string, value: hint.value as string, prefix: hint.prefix })
    }
  }
  pending[origin] = forOrigin
  await chrome.storage.session.set({ [PENDING_KEY]: pending })
}

/** Flattened for the review page, which asks one question per origin and header. */
async function pendingForReview(): Promise<{ origin: string; header: string; value: string }[]> {
  const pending = await pendingLiterals()
  return Object.entries(pending).flatMap(([origin, entries]) =>
    entries.map((entry) => ({ origin, header: entry.header, value: `${entry.prefix}${entry.value}` })),
  )
}

/** What the review page offers: every origin with a header nobody has decided about yet. */
export async function pendingLiterals(): Promise<Record<string, ParkedLiteral[]>> {
  const stored = await chrome.storage.session.get(PENDING_KEY)
  return (stored[PENDING_KEY] as Record<string, ParkedLiteral[]> | undefined) ?? {}
}

/** The decision. Allowing one persists it for that origin; refusing forgets it. */
export async function decideLiteral(origin: string, header: string, allow: boolean): Promise<void> {
  const pending = await pendingLiterals()
  const entry = (pending[origin] ?? []).find((candidate) => candidate.header === header)
  pending[origin] = (pending[origin] ?? []).filter((candidate) => candidate.header !== header)
  await chrome.storage.session.set({ [PENDING_KEY]: pending })
  if (!allow || !entry) return
  const stored = await chrome.storage.local.get(LITERALS_KEY)
  const allowed = (stored[LITERALS_KEY] as Record<string, ParkedLiteral[]> | undefined) ?? {}
  allowed[origin] = [...(allowed[origin] ?? []).filter((c) => c.header !== header), entry]
  await chrome.storage.local.set({ [LITERALS_KEY]: allowed })
}

// --- capture --------------------------------------------------------------

/** Origin and path, never the query: a query string carries tokens and no filter reads one. */
const withoutQuery = (url: string): string => {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '(unparseable url)'
  }
}

function emit(draft: ExchangeDraft): void {
  if (!recording) return
  if (!admits(draft, noise)) {
    // The one drop with no trace anywhere: the counter does not move, no badge changes, nothing
    // reaches the review page, and the user is left with "I made a request and Douze ignored it".
    // The store's own refusal has said why since T-001; this is the same courtesy one step
    // earlier. Method, origin and path only — a query string carries tokens, and no filter
    // decision has ever depended on one.
    console.debug(`Douze skipped ${draft.method} ${withoutQuery(draft.url)} (${draft.response_content_type ?? 'no body'})`)
    return
  }
  // Parked and removed from the draft: `finalize` must never see a value, because what it produces
  // is what reaches disk.
  if ((draft.credentials ?? []).some((hint) => hint.value !== undefined)) {
    void parkLiteral(draft)
    draft = { ...draft, credentials: (draft.credentials ?? []).map(({ value: _v, ...rest }) => rest) }
  }
  const gesture = draft.gesture ?? (draft.tab_id === undefined ? undefined : lastGesture.get(draft.tab_id))
  const exchange = finalize(
    draft,
    { session_id: recording.session.id, position: recording.position, gesture },
    crypto.randomUUID(),
  )
  // Claimed synchronously, before the write is awaited: `position` is the order the store indexes
  // on, so it has to be the order the pipeline produced, not the order IndexedDB finishes in.
  recording.position += 1
  if (exchange.origin && !recording.seenOrigins.includes(exchange.origin)) {
    recording.seenOrigins.push(exchange.origin)
  }
  void sequence(() => record(exchange))
}

/**
 * REQ-CAP-005 — `finalize` already redacted this exchange in the worker. The store re-redacts and
 * then refuses anything `findSurvivingSecrets` still recognises, which is a second, fail-closed
 * check rather than the redaction itself.
 *
 * A refusal drops the exchange and leaves its position unused — the count, and so the badge and
 * the retained total, only ever reports what is readable back out of the store.
 */
async function record(exchange: Exchange): Promise<void> {
  const { captures } = await openStores()
  try {
    await captures.appendExchange(exchange)
  } catch (error) {
    // Never silent: the gate refusing is a credential that survived redaction, which is a bug in
    // redaction and the one thing worth a line in the worker's log.
    console.warn(`Douze dropped an exchange: ${String((error as Error)?.message ?? error)}`)
    return
  }
  if (recording?.session.id !== exchange.session_id) return
  recording.count += 1
  await persist()
  await paintBadge()
}

/** T-002.6 — the MAIN-world capture claims a request; slower paths emit only if it did not. */
function route(draft: ExchangeDraft): void {
  for (const ready of reconciler.accept(draft, Date.now())) emit(ready)
  setTimeout(() => {
    for (const ready of reconciler.due(Date.now())) emit(ready)
  }, RECONCILE_GRACE_MS + 50)
}

const headerValue = (headers: Record<string, string>, name: string): string | undefined => {
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name)
  return match === undefined ? undefined : headers[match]
}

function ingest(batch: PageEvent[], tabId: number, pageOrigin?: string): void {
  for (const event of batch) {
    if (event.type === 'gesture') {
      lastGesture.set(tabId, event)
      continue
    }
    if (event.type === 'request') {
      // Snapshot the gesture now: the bridge delivers a click before the fetch it triggered,
      // but the exchange is not emitted until its response, by which point a later click has
      // already replaced it.
      const caused = lastGesture.get(tabId)
      pendingRequests.set(`${tabId}:${event.id}`, {
        event,
        ...(caused === undefined ? {} : { gesture: caused }),
      })
      continue
    }
    const key = `${tabId}:${event.id}`
    const pending = pendingRequests.get(key)
    pendingRequests.delete(key)
    if (event.type === 'error' || !pending) continue
    const { event: request, gesture } = pending

    // Case-insensitively, because a header name is: the page sends `Content-Type`, and looking
    // for the lower-case spelling found nothing — so a JSON request body was never parsed, stayed
    // a string, and inference saw no fields to turn into tool parameters. Every write tool came
    // out with no arguments at all, replaying one frozen captured body.
    const requestBody = decodeBody(request.body, headerValue(request.headers, 'content-type'))
    const contentType = headerValue(event.headers, 'content-type')
    const responseBody = decodeBody(event.body, contentType)
    // For a body we cut short, the header is the honest size; ours is only what we kept.
    const declaredSize = Number(event.headers['content-length'])
    const size = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : responseBody.size
    route({
      // The frame's own origin, established by the message handler before ingest is reached, so a
      // page cannot claim to be somebody else.
      ...(pageOrigin === undefined ? {} : { page_origin: pageOrigin }),
      ...(request.credentials?.length ? { credentials: request.credentials } : {}),
      method: request.method,
      url: event.url || request.url,
      started_at: request.t,
      duration_ms: Math.max(0, event.t - request.t),
      request_headers: request.headers,
      ...(requestBody.value === undefined ? {} : { request_body: requestBody.value }),
      status: event.status,
      response_headers: event.headers,
      ...(responseBody.value === undefined ? {} : { response_body: responseBody.value }),
      ...(contentType === undefined ? {} : { response_content_type: contentType }),
      ...(size === undefined ? {} : { response_size: size }),
      body_missing: responseBody.missing !== undefined,
      ...(responseBody.missing === undefined ? {} : { body_missing_reason: responseBody.missing }),
      source: 'main_world',
      tab_id: tabId,
      ...(gesture === undefined ? {} : { gesture }),
    })
  }
}

// --- session lifecycle ----------------------------------------------------

/**
 * The MAIN-world `fetch` patch and the ISOLATED bridge, registered for exactly as long as the
 * state that justifies them.
 *
 * `persistAcrossSessions: false` is not a performance choice: `recording` lives in
 * `chrome.storage.session`, which Chrome clears on browser restart, and a registration that
 * outlived it left every recorded origin carrying a patched `fetch` with nothing left in the
 * extension that knew why — no session to stop, no badge, and no `onStartup` listener to
 * reconcile it. `false` matches the two lifetimes: Chrome keeps a non-persistent registration for
 * the whole browser session, worker evictions included (which is why a mid-session eviction still
 * records), and drops it on the restart that also drops the session state.
 *
 * The unregister on stop stays, because a session that ends before the browser does must take the
 * injection with it — this only fixes the case where nothing gets to run a stop at all.
 */
async function registerScripts(origins: string[]): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: RECONCILE_IDS }).catch(() => {})
  if (!origins.length) return
  const matches = origins.map((origin) => `${origin}/*`)
  await chrome.scripting.registerContentScripts([
    {
      id: 'douze-main',
      js: ['interceptor.js'],
      world: 'MAIN',
      runAt: 'document_start',
      matches,
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: false,
    },
    {
      id: 'douze-bridge',
      js: ['bridge.js'],
      world: 'ISOLATED',
      runAt: 'document_start',
      matches,
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: false,
    },
  ])
}

/** The tab a session records: the one the popup was opened over, else the first on the origin. */
async function resolveTab(origin: string, tabId?: number): Promise<number> {
  if (tabId !== undefined && tabId >= 0) return tabId
  const tabs = await chrome.tabs.query({})
  const match = tabs.find((tab) => tab.url?.startsWith(`${origin}/`) || tab.url === origin)
  if (match?.id === undefined) throw new Error(`no open tab on ${origin} to record`)
  return match.id
}

/** AC-CAP-001.1 / .2 — a named session scoped to the origins the user granted. */
async function startSession(
  command: Extract<PopupCommand, { type: 'douze:start' }>,
): Promise<PopupStatus & { error?: string }> {
  const [primary] = command.origins
  if (!primary) throw new Error('a session needs at least one origin')
  const tabId = await resolveTab(primary, command.tabId)
  const { captures } = await openStores()
  // The store allocates the id and stamps `started_at`, and it is written before `recording` is
  // set: an exchange whose session row is not there yet is an orphan no review page can open.
  const session = await captures.startSession({
    // An unnamed session is named after the site rather than refused: the name is a label.
    name: command.name.trim() || new URL(primary).hostname,
    origins: command.origins,
    debugger_enabled: command.useDebugger,
  })
  recording = { session, tabId, position: 0, count: 0, seenOrigins: [] }
  await persist()
  await registerScripts(session.origins)
  // Registration does not affect an already-loaded tab, and document_start injection is the
  // whole point — patch `fetch` before page scripts capture a reference to it. Both branches
  // reload, so a caller never has to; `attach` reloads to make bodies retrievable at all.
  //
  // A swallowed attach failure took the reload with it: the session ran with no interceptor in
  // the page and no debugger either, recorded nothing, and said nothing. The reload happens
  // whatever attach does, and the reason reaches the popup.
  let attachError: string | undefined
  if (command.useDebugger) {
    try {
      await debuggerCapture.attach(tabId)
    } catch (error) {
      attachError = `Douze couldn't attach the debugger (${(error as Error)?.message ?? error}), so it's watching the ordinary way instead.`
      await chrome.tabs.reload(tabId)
    }
  } else {
    await chrome.tabs.reload(tabId)
  }
  await paintBadge()
  return { ...status(), ...(attachError === undefined ? {} : { error: attachError }) }
}

/**
 * AC-CAP-001.4 — stopping reports the count retained after filtering.
 *
 * ponytail: a draft still inside the reconciler's RECONCILE_GRACE_MS window is dropped, so the
 * last request or two of a session can be lost if the user presses Done the instant it fires.
 * Drain the reconciler here if that ever costs anyone a tool.
 */
async function stopSession(): Promise<PopupStatus> {
  const stopping = recording
  if (stopping) {
    const { captures } = await openStores()
    // Behind the write queue, so `retained` counts the exchanges still being written when the
    // user pressed Done rather than only those that had already landed.
    await sequence(() => captures.stopSession(stopping.session.id))
  }
  await debuggerCapture.detachAll()
  await chrome.scripting.unregisterContentScripts({ ids: RECONCILE_IDS }).catch(() => {})
  recording = null
  pendingRequests.clear()
  lastGesture.clear()
  await persist()
  await paintBadge()
  return status()
}

/**
 * AC-CAP-007.1 / .2 — the note covers every exchange since the previous note.
 *
 * The span is computed by the store from the spans and positions it already holds, so the worker
 * keeps no "annotated through" counter of its own to drift from what was actually written.
 */
function annotate(note: string): void {
  if (!recording || !note.trim()) return
  const sessionId = recording.session.id
  // Truncated rather than refused. The note is free text the user typed to describe what they just
  // did, and this path is fire-and-forget: a note the store rejects would throw into the write
  // chain and vanish with nothing said, which is the worst of both. The popup's `maxlength` stops
  // it happening at all; this is what keeps the worker honest if anything else ever calls in.
  const text = note.trim().slice(0, MAX_NOTE_CHARS)
  void sequence(async () => (await openStores()).captures.annotate(sessionId, text))
}

/**
 * The review page, opened from here rather than from the popup.
 *
 * The popup asks for permission on the origins the session recorded, and Chrome closes a popup
 * to show that prompt — so anything the popup queued behind the answer never ran, and pressing
 * the button appeared to do nothing at all. The worker outlives the prompt.
 *
 * WO-015 T-015.4 — an extension page, not a daemon URL. The session id is in the query string
 * because there is nothing left to authenticate: only this extension can open `chrome-extension://`.
 */
async function openReview(sessionId: string): Promise<void> {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`review.html?session=${encodeURIComponent(sessionId)}`),
  })
}

/** The connect page, opened the same way and from the same place, for the same reason. */
async function openConnect(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('connect.html') })
}

/** The data page — what is stored on this computer. Opened by the worker, as the other two are. */
async function openData(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('data.html') })
}

// --- review ---------------------------------------------------------------

/**
 * Inference is expensive and every command names its session, so the session is built once and
 * kept, alongside the exchange count it was built from. It is in-memory only.
 *
 * The count it was built from is kept beside it because a review can be opened while the site is
 * still being recorded: inference ran over the exchanges that had landed by then, and a session
 * kept by id alone would show that same candidate set for the rest of the recording. The daemon
 * re-inferred when the count moved, and so does this.
 *
 * Only `load` re-infers, though — it is the command that redraws the whole candidate set, so it is
 * the one place a rebuild costs nothing. Rebuilding under `enable`/`disable`/`save` would throw
 * away the approvals the page sent moments earlier, for a capture that happened to grow between
 * two of its own messages.
 *
 * ponytail: a worker Chrome respawns mid-review loses unsaved edits and approvals, and the page
 * silently rebuilds from the capture. Persist the session if anyone ever loses work to it.
 */
const reviews = new Map<string, { session: ReviewSession; count: number }>()

/**
 * An imported recipe reviewed rather than a capture. `RecipeStore.importFiles` lands every
 * imported tool unapproved whatever the file said, so a file needs the same page a recording gets;
 * this is the id the data page's "Set up skills" button sends for one. It rides in `sessionId`
 * because every review command already names its subject there and a second field would be a
 * second thing every caller has to get right.
 */
export const RECIPE_REVIEW_PREFIX = 'recipe:'

async function reviewSession(sessionId: string, reinfer: boolean): Promise<ReviewSession> {
  const stores = await openStores()
  if (sessionId.startsWith(RECIPE_REVIEW_PREFIX)) {
    // No re-inference: there is no capture to grow, and rebuilding would drop the reader's ticks.
    const open = reviews.get(sessionId)
    if (open) return open.session
    const session = await ReviewSession.openRecipe(sessionId.slice(RECIPE_REVIEW_PREFIX.length), stores)
    reviews.set(sessionId, { session, count: 0 })
    return session
  }
  const count = await stores.captures.countExchanges(sessionId)
  const open = reviews.get(sessionId)
  if (open && (!reinfer || open.count === count)) return open.session
  const session = await ReviewSession.open(sessionId, stores)
  reviews.set(sessionId, { session, count })
  return session
}

async function onReviewCommand(command: ReviewCommand): Promise<ReviewState | ReviewSaved | { ok: true }> {
  const session = await reviewSession(command.sessionId, command.type === 'douze:review:load')
  if (command.type === 'douze:review:load') {
    return {
      site: session.site(),
      recipe: session.recipeName(),
      candidates: session.candidates(),
      pending_credentials: await pendingForReview(),
    }
  }
  if (command.type === 'douze:review:credential') {
    await decideLiteral(command.origin, command.header, command.allow)
    return {
      site: session.site(),
      recipe: session.recipeName(),
      candidates: session.candidates(),
      pending_credentials: await pendingForReview(),
    }
  }
  if (command.type === 'douze:review:edit') {
    session.edit(command.name, command.field, command.value)
    /**
     * AC-REC-002.2 — the edit reaches the recipe immediately, so the surface picks it up without
     * the user remembering to press anything.
     *
     * Only once something is approved. `save()` refuses to write a recipe with nothing in it, and
     * the review page's own order is correct-then-keep: every edit made before the first tick came
     * back as "Couldn't save that. Nothing has changed", which was true of the recipe and not of
     * the correction the page then threw away. It is held in the session either way, and the Keep
     * button saves it.
     */
    if (session.candidates().some((candidate) => candidate.approved)) await session.save()
    return { ok: true }
  }
  if (command.type === 'douze:review:enable') {
    session.approve(command.names)
    return { ok: true }
  }
  if (command.type === 'douze:review:disable') {
    session.unapprove(command.names)
    return { ok: true }
  }
  await session.save()
  // Read back rather than trusting a report shape: what is approved now is what the surface holds.
  return { tools: session.candidates().filter((c) => c.approved).map((c) => c.name) }
}

// --- what is stored on this computer --------------------------------------

/**
 * The routes behind the data page. Each one reaches a store method that had no caller at all
 * after the CLI was deleted: `importHar` (`douze import`), `RecipeStore.exportAll`/`importFiles`
 * (`douze export` / `douze import`), and `CaptureStore.deleteSession`, which nothing anywhere
 * could reach — so a recording of an authenticated dashboard stayed in IndexedDB, under
 * `unlimitedStorage`, until the extension itself was removed.
 */
async function dataState(extra: Partial<DataState> = {}): Promise<DataState> {
  const { captures, recipes } = await openStores()
  return {
    sessions: await captures.sessions(),
    recipes: recipes
      .recipes()
      .map((recipe) => ({ name: recipe.name, tools: recipe.tools.filter((tool) => tool.approved).length }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    calls: await recentCalls(),
    ...extra,
  }
}

async function onDataCommand(command: DataCommand): Promise<DataState> {
  try {
    const { captures, recipes } = await openStores()
    if (command.type === 'douze:data:delete') {
      // Behind the capture queue, like `stopSession`: deleting a session that is still being
      // written to must not race the append, or the rows written after the delete survive it.
      await sequence(() => captures.deleteSession(command.sessionId))
      // The in-memory review of a capture that no longer exists is not a review of anything.
      reviews.delete(command.sessionId)
      return await dataState()
    }
    if (command.type === 'douze:data:delete-recipe') {
      // `RecipeStore.delete` had no caller at all. Its `refresh` fires the surface subscription,
      // so the tools it carried leave every attached host without anything here pushing.
      await recipes.delete(command.name)
      // The in-memory review of a recipe that no longer exists is not a review of anything.
      reviews.delete(RECIPE_REVIEW_PREFIX + command.name)
      return await dataState()
    }
    if (command.type === 'douze:data:clear-audit') {
      await clearCalls()
      return await dataState()
    }
    if (command.type === 'douze:data:import-har') {
      // Same queue for the same reason, and because an import is hundreds of writes: interleaving
      // them with a live recording's appends would put both behind each other's transactions.
      const har = await sequence(() => importHar(command.har, command.name, captures))
      return await dataState({ har })
    }
    if (command.type === 'douze:data:export') return await dataState({ files: await recipes.exportAll() })
    if (command.type === 'douze:data:import') {
      const imported = await recipes.importFiles(command.files, command.overwrite === true ? { overwrite: true } : {})
      // A re-import replaces the stored recipe, so any review held open over the old one is stale.
      for (const name of imported.imported) reviews.delete(RECIPE_REVIEW_PREFIX + name)
      return await dataState({ imported })
    }
    return await dataState()
  } catch (error) {
    // As on the connect page: the sentence is what the reader can do about it, and the screen is
    // re-rendered from a state that reflects that nothing changed.
    return dataState({ error: String((error as Error)?.message ?? error) })
  }
}

// --- connect --------------------------------------------------------------

/**
 * WO-015 T-015.10 — **the no-terminal path.** `douze connect <url>` needed a terminal that the
 * people this product is for do not have, so minting, rotating and retiring a relay endpoint
 * happens here, driven by the connect page.
 *
 * Everything written by these commands goes to `attach:relay` and nowhere else. The attachment
 * client re-reads that key on its own alarm and re-dials within 30 seconds, because its attachment
 * key carries the token and the write opt-in; nothing here touches a socket. Two writers to one
 * connection is a race, and one storage key both halves already agree on is not.
 */
/**
 * The relay a user who types nothing gets. **It is run by Jaume Alavedra, who wrote Douze, on a
 * personal server** — not a company, and with no agreement behind it. The connect page names him
 * beside this address for the same reason the comment does: "whoever runs it can read everything
 * that crosses it" is only actionable once the reader knows who that is.
 */
const DEFAULT_RELAY_URL = 'https://douze.jamalavedra.com'

/**
 * Well under the 30 seconds a worker-issued fetch may take before Chrome kills the worker
 * mid-registration — which would leave a live endpoint on the relay that nothing here has the
 * token for.
 */
const RELAY_TIMEOUT_MS = 15_000

/** What `POST /register` and `POST /rotate` answer with (packages/relay/README.md). */
interface Registration {
  token: string
  mcp_path: string
}

async function connectState(extra: Partial<ConnectState> = {}): Promise<ConnectState> {
  const stored = await chrome.storage.local.get([RELAY_KEY, BRIDGE_KEY, EXPOSE_KEY])
  const relay = stored[RELAY_KEY] as RelayPairing | undefined
  const bridge = (stored[BRIDGE_KEY] as BridgePairing | undefined) ?? {}
  const expose = stored[EXPOSE_KEY] as Partial<ExposeLists> | undefined
  return {
    configured: relay !== undefined,
    url: relay?.url ?? DEFAULT_RELAY_URL,
    mcp_url: relay === undefined ? '' : `${relay.url}${relay.mcp_path}`,
    allow_writes: relay?.allow_writes ?? true,
    connected: attachments.connected(),
    tools: liveSurface.map((entry) => entry.qualified_name),
    exposed: { local: expose?.local ?? [], remote: expose?.remote ?? [] },
    bridge: bridgeState(bridge),
    stale: attachments.relayRefused(),
    ...extra,
  }
}

/**
 * A refusal is not stored — it is the word of a peer that proved nothing, and it stops one port
 * rather than the pairing (packages/extension/src/attach.ts, `refused`) — so it is asked for here
 * rather than read out of storage, and it outranks `paired` only while no bridge is actually up.
 */
const bridgeState = (bridge: BridgePairing): ConnectState['bridge'] => {
  if (attachments.bridgeRefused()) return 'refused'
  if (bridge.secret) return 'paired'
  return bridge.code ? 'trying' : 'unpaired'
}

/** The stored pairing, or the reason there is nothing to rotate, stop or change. */
async function storedRelay(): Promise<RelayPairing> {
  const stored = await chrome.storage.local.get(RELAY_KEY)
  const relay = stored[RELAY_KEY] as RelayPairing | undefined
  if (!relay) throw new Error('Douze is not sharing with a hosted assistant, so there is nothing to change.')
  return relay
}

/**
 * A relay address Douze is willing to hand its link to. Plain http is refused off the loopback
 * interface because the link IS the password, and an address the user mistyped must fail here
 * rather than as a network error nobody can act on.
 */
function relayBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`"${url}" is not a web address. It should look like ${DEFAULT_RELAY_URL}.`)
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) return trimmed
  throw new Error(
    `A relay address has to start with https:// — the link is the password, and plain http would ` +
      `send it across the internet in the clear.`,
  )
}

/**
 * One call to the relay's own HTTP API, in the user's language when it fails.
 *
 * The host permission is checked first and named: a worker's `fetch` to a relay Chrome has not
 * granted fails as an opaque network error, and "check you are online" would send someone looking
 * at their wifi for a permission they can grant in one click.
 */
async function relayFetch(
  base: string,
  path: string,
  init: { method: string; token?: string; body?: unknown },
): Promise<Registration | null> {
  const origin = new URL(base).origin
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    throw new Error(`Chrome has not given Douze permission to reach ${origin}. Try again and choose Allow.`)
  }
  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      method: init.method,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { 'x-douze-relay-token': init.token }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    })
  } catch {
    throw new Error(`Douze could not reach ${origin}. Check that you are online and that the address is right.`)
  }
  if (response.status === 401) {
    throw new Error(`${origin} does not recognise this link any more. Stop sharing, then connect again.`)
  }
  if (response.status === 429) {
    throw new Error(`${origin} is not handing out new links at the moment. Try again in an hour.`)
  }
  if (!response.ok) throw new Error(`${origin} answered with an error (${response.status}). Nothing changed.`)
  if (response.status === 204) return null
  const body = (await response.json().catch(() => null)) as Registration | null
  if (typeof body?.token !== 'string' || typeof body.mcp_path !== 'string') {
    throw new Error(`${origin} answered with something Douze did not understand. It may not be a Douze relay.`)
  }
  return body
}

/** `POST /register`, then the pairing the attachment client will find on its next alarm. */
async function startLink(url: string | undefined): Promise<ConnectState> {
  const base = relayBase(url ?? DEFAULT_RELAY_URL)
  const registered = await relayFetch(base, '/register', {
    method: 'POST',
    body: { daemon_version: chrome.runtime.getManifest().version },
  })
  if (!registered) throw new Error(`${base} did not hand back a link. Nothing is being shared.`)
  await chrome.storage.local.set({
    [RELAY_KEY]: {
      url: base,
      token: registered.token,
      mcp_path: registered.mcp_path,
      // On from the start: a connector that can only read is not what anyone connects Douze for,
      // and the read-only default meant every user met the feature as a tool that refused. What
      // it costs is disclosed on the connect page before the link is minted rather than in a
      // dialog nobody now sees; deleting stays impossible from a hosted assistant either way.
      allow_writes: true,
    } satisfies RelayPairing,
  })
  return connectState()
}

/**
 * `POST /rotate`. The relay kills the old token and URL the moment it answers, so the pairing is
 * REPLACED here — a second stored pairing would leave the extension dialling with a token the
 * relay has already forgotten, and the user believing an address that is dead.
 */
async function rotateLink(): Promise<ConnectState> {
  const relay = await storedRelay()
  const rotated = await relayFetch(relay.url, '/rotate', { method: 'POST', token: relay.token })
  if (!rotated) throw new Error(`${relay.url} did not hand back a new link. The one you have still works.`)
  await chrome.storage.local.set({
    [RELAY_KEY]: { ...relay, token: rotated.token, mcp_path: rotated.mcp_path } satisfies RelayPairing,
  })
  // The old token is dead the moment the relay answered; without this the socket holding it stays
  // up until the next alarm, up to 30 seconds of an attachment the relay has already forgotten.
  await attachments.tick()
  return connectState()
}

/**
 * `DELETE /register`, best effort. Someone who wants to stop sharing must always be able to, so a
 * relay that cannot be reached does not block it: the pairing goes either way and the page is told
 * plainly that the relay was not informed.
 */
async function stopLink(): Promise<ConnectState> {
  const relay = await storedRelay()
  let warning: string | undefined
  try {
    await relayFetch(relay.url, '/register', { method: 'DELETE', token: relay.token })
  } catch (error) {
    warning =
      `Douze stopped sharing and the link no longer works from this computer, but it could not tell ` +
      `${relay.url} to drop it: ${String((error as Error)?.message ?? error)}`
  }
  await chrome.storage.local.remove(RELAY_KEY)
  // Stopping means stopping now. The `DELETE` above is best effort and may well have failed, in
  // which case closing this socket is the only thing that ends the sharing at all.
  await attachments.tick()
  return connectState(warning === undefined ? {} : { warning })
}

/**
 * T-015.9 — the write opt-in, stored on the pairing. The attachment key includes it, so the client
 * closes the socket it has and dials a new one that pushes the surface this opt-in implies.
 * Destructive tools are not on either surface and this does not put them there.
 *
 * Ticked here rather than left to the alarm, because the direction that matters is OFF: the live
 * attachment froze `allowWrites` at construction, so a host the user has just restricted would go
 * on completing writes for up to 30 seconds, and nothing on the relay side helps.
 */
async function setWrites(allow: boolean): Promise<ConnectState> {
  const relay = await storedRelay()
  await chrome.storage.local.set({ [RELAY_KEY]: { ...relay, allow_writes: allow } satisfies RelayPairing })
  await attachments.tick()
  return connectState()
}

async function onConnectCommand(command: ConnectCommand): Promise<ConnectState> {
  try {
    if (command.type === 'douze:connect:pair') {
      await attachments.pair(command.code)
      return await connectState()
    }
    if (command.type === 'douze:connect:unpair') {
      await attachments.unpair()
      return await connectState()
    }
    if (command.type === 'douze:connect:expose') {
      await attachments.setExposed(command.trust, command.tool, command.allow)
      return await connectState()
    }
    if (command.type === 'douze:connect:start') return await startLink(command.url)
    if (command.type === 'douze:connect:rotate') return await rotateLink()
    if (command.type === 'douze:connect:stop') return await stopLink()
    if (command.type === 'douze:connect:writes') return await setWrites(command.allow)
    return await connectState()
  } catch (error) {
    // The page renders `error` and changes nothing on screen, so what it says has to be what the
    // reader can do about it — every throw above is written for them.
    return connectState({ error: String((error as Error)?.message ?? error) })
  }
}

const status = (): PopupStatus => ({
  session: recording
    ? { id: recording.session.id, name: recording.session.name, origins: recording.session.origins }
    : null,
  count: recording?.count ?? 0,
  seenOrigins: recording?.seenOrigins ?? [],
  noiseHosts,
})

// --- the site's tool surface ----------------------------------------------

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * What is already set up on a site, for the popup's quiet summary. This is douzed's
 * `GET /api/site-tools` with the same filter, reading `RecipeStore.surface()` where that read the
 * daemon's registry — the popup no longer reaches over loopback to ask anybody.
 */
async function siteTools(origin: string): Promise<SiteTool[]> {
  const wanted = originOf(origin)
  if (!wanted) return []
  const { recipes } = await openStores()
  return recipes
    .surface()
    .tools.filter((entry) => originOf(entry.base_url) === wanted)
    .map((entry) => ({
      name: entry.qualified_name,
      description: entry.tool.description,
      side_effect: entry.tool.side_effect,
    }))
}

// --- listeners (top level, synchronous) -----------------------------------

type Inbound = CaptureBatch | PopupCommand | ReviewCommand | ConnectCommand | DataCommand

/**
 * Everything except a capture batch comes from an extension page — the popup, the review page,
 * the connect page — and every one of those routes changes state or hands back a capture.
 *
 * `sender.tab === undefined` is NOT the discriminator, and getting that wrong is what let a
 * content script reach these: an extension page open in a tab has `sender.tab` set exactly as a
 * content script does. The URL is what separates them, because a content script's `sender.url` is
 * the page it was injected into and Chrome fills both in itself. Cross-extension messages arrive
 * on `onMessageExternal`, which is not wired up at all, so the scheme is the whole test.
 */
const fromExtensionPage = (sender: chrome.runtime.MessageSender): boolean =>
  sender.url?.startsWith('chrome-extension://') === true

chrome.runtime.onMessage.addListener((message: Inbound, sender, sendResponse) => {
  if (message.type === 'douze:capture') {
    const tabId = sender.tab?.id
    // Everything arriving from a content script is attacker-controlled: a page can forge these,
    // so the frame's own origin — not anything in the message — decides whether we listen.
    if (tabId === undefined) return undefined
    void hydrated.then(() => {
      if (!recording || !recording.session.origins.includes(sender.origin ?? '')) return
      ingest(message.batch.slice(0, 200), tabId, sender.origin)
    })
    return undefined
  }
  // Refused with no answer at all: a forged command gets nothing back to distinguish "refused"
  // from "no such command", and nothing here has run.
  if (!fromExtensionPage(sender)) return undefined
  void hydrated
    .then(async () => {
      // The pages come first: they are the only senders that are not the popup, and every one of
      // their commands names its own session rather than reading the worker's live state.
      if (message.type.startsWith('douze:review:')) return onReviewCommand(message as ReviewCommand)
      if (message.type.startsWith('douze:connect:')) return onConnectCommand(message as ConnectCommand)
      if (message.type.startsWith('douze:data:')) return onDataCommand(message as DataCommand)
      if (message.type === 'douze:start') return startSession(message)
      if (message.type === 'douze:stop') return stopSession()
      if (message.type === 'douze:annotate') {
        annotate(message.note)
        return status()
      }
      if (message.type === 'douze:noise') {
        await chrome.storage.local.set({ noise_hosts: message.hosts })
        // Read straight back rather than waiting for `storage.onChanged`: this is the only writer,
        // and the reply has to carry the list the user just saved.
        await loadSettings()
        return status()
      }
      if (message.type === 'douze:site-tools') return { tools: await siteTools(message.origin) }
      // AC-EXE-003.3 — the local audit `douze status` used to print, read back from storage.
      if (message.type === 'douze:audit') return { calls: await recentCalls(message.limit) }
      if (message.type === 'douze:review') {
        await openReview(message.sessionId)
        return status()
      }
      if (message.type === 'douze:connect') {
        await openConnect()
        return status()
      }
      if (message.type === 'douze:data') {
        await openData()
        return status()
      }
      return status()
    })
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ error: String((error as Error)?.message ?? error) }))
  return true
})

installOracle({
  isRecording: (tabId) => recording !== null && tabId === recording.tabId,
  onObserved: (draft) => route(draft),
})

// Dynamic registrations are wiped on every extension update and reload.
chrome.runtime.onInstalled.addListener(() => {
  void hydrated.then(async () => {
    await DebuggerCapture.clearZombies()
    if (recording) await registerScripts(recording.session.origins)
  })
})

/**
 * AC-EXE-002.3 — clicking the "signed out" notification opens the site's own login page, which is
 * the only action that fixes it. Anything Douze raised without a target opens the connect page.
 */
chrome.notifications.onClicked.addListener((id) => {
  const url = notificationTargets.get(id)
  if (!url) return
  notificationTargets.delete(id)
  void chrome.tabs.create({ url })
  void chrome.notifications.clear(id)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  lastGesture.delete(tabId)
  void debuggerCapture.detach(tabId)
})

// --- e2e surface ----------------------------------------------------------

/**
 * Reachable from `serviceWorker.evaluate()`, which can only see `globalThis`. Every entry
 * calls the same function the popup's message handler calls — there is no test-only path.
 */
Object.assign(globalThis, {
  __douze: {
    async startSession(
      name: string,
      origins: string[],
      opts: { debugger?: boolean; tabId?: number } = {},
    ): Promise<string> {
      await hydrated
      await startSession({
        type: 'douze:start',
        name,
        origins,
        useDebugger: opts.debugger ?? false,
        ...(opts.tabId === undefined ? {} : { tabId: opts.tabId }),
      })
      return recording?.session.id ?? ''
    },
    async stopSession(): Promise<{ retained: number }> {
      await hydrated
      const sessionId = recording?.session.id
      await stopSession()
      if (sessionId === undefined) return { retained: 0 }
      // The store's count, not the worker's: what survived the write gate is what was retained.
      return { retained: await (await openStores()).captures.countExchanges(sessionId) }
    },
    async annotate(note: string): Promise<void> {
      await hydrated
      annotate(note)
      // The note is written behind the capture queue; a caller that asserts on it must be able to
      // wait for it. This is the same queue, so it is empty only once the note has landed.
      await sequence(async () => undefined)
    },
    /** AC-CAP-001.3 — the text `chrome.action.setBadgeText` was last given. */
    badgeCount: (): number => Number(painted || 0),
    /**
     * What is actually in the store for a session — exchanges in position order and the spans
     * over them. Replaces the outbox `pending()` gave a view of: the store IS where a capture goes
     * now, so this reads the same rows the review page reads.
     */
    async recorded(sessionId: string): Promise<{ exchanges: unknown[]; annotations: unknown[] }> {
      await sequence(async () => undefined)
      const detail = await (await openStores()).captures.session(sessionId)
      return { exchanges: detail?.exchanges ?? [], annotations: detail?.annotations ?? [] }
    },
    /**
     * Whether the origin is granted. It cannot be granted from here: `permissions.request`
     * needs a user gesture, so the e2e build bakes the origin in via `DOUZE_TEST_ORIGIN`.
     */
    hasOrigin: (origin: string): Promise<boolean> =>
      chrome.permissions.contains({ origins: [`${origin}/*`] }),
    /** Whether any host is attached right now, and what the last few calls did. */
    async attached(): Promise<boolean> {
      await dialled
      return attachments.connected()
    },
    calls: (limit?: number) => recentCalls(limit),
    status,
  },
})
