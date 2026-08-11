import {
  DEFAULT_PORT,
  NOISE_HOSTS,
  type AnnotationSpan,
  type ClientMessage,
  type CaptureSession,
  type NoiseConfig,
  type ServerMessage,
} from '@douze/shared'
import type {
  CaptureBatch,
  ConnectCommand,
  ConnectState,
  GestureEvent,
  PageEvent,
  PopupCommand,
  PopupStatus,
  RequestEvent,
  ReviewCommand,
  ReviewSaved,
  ReviewState,
} from './messages.js'
import { needsPairing, pairAny } from './daemon.js'
import { DebuggerCapture } from './debugger-capture.js'
import { installOracle } from './oracle.js'
import { RECONCILE_GRACE_MS, Reconciler, admits, decodeBody, finalize, type ExchangeDraft } from './pipeline.js'
import { RecipeStore } from './recipes.js'
import { executeRelay } from './relay.js'
import { ReviewSession } from './review-session.js'
import { CaptureStore } from './store.js'
import { DaemonSocket } from './ws-client.js'

/**
 * T-001.4 / T-002.2 — the service worker. It owns session lifecycle, provenance attribution,
 * redaction (in `finalize`), reconciliation across capture paths, and the douzed socket.
 *
 * Every listener below is registered synchronously at the top level: a listener added after an
 * `await` silently stops working once Chrome respawns the worker.
 */

const VERSION = chrome.runtime.getManifest().version
const RECONCILE_IDS = ['douze-main', 'douze-bridge']
const RECONNECT_ALARM = 'douze-reconnect'

interface Recording {
  session: CaptureSession
  tabId: number
  /** Next position to assign; Annotation Spans index into the same sequence. */
  position: number
  annotatedThrough: number
  count: number
  /**
   * Every origin the page actually talked to — usually its API host rather than its own. The
   * popup asks Chrome for permission on these when the session ends, because the relay replays
   * inside a tab on the *target* origin and cannot touch one that was never granted.
   */
  seenOrigins: string[]
}

let recording: Recording | null = null
// `DEFAULT_PORT` is a literal type; the stored port is whichever one the daemon actually took.
let settings = { port: DEFAULT_PORT as number, token: '', noiseHosts: [] as string[] }
/** AC-CAP-004.1 / .3 — the bundled list plus the user's additions; never a copy of the list. */
let noise: NoiseConfig = { hosts: NOISE_HOSTS }
const pendingRequests = new Map<string, { event: RequestEvent; gesture?: GestureEvent }>()
const lastGesture = new Map<number, GestureEvent>()
const reconciler = new Reconciler()
const expiredNotifications = new Map<string, string>()

const debuggerCapture = new DebuggerCapture((draft) => emit(draft))

const socket = new DaemonSocket({
  port: settings.port,
  token: settings.token,
  version: VERSION,
  onMessage: (message) => void onServerMessage(message),
})

/**
 * T-001.4 — the buffer outlives the worker. Chrome suspends an idle service worker after 30
 * seconds, and a socket that is down is precisely when nothing keeps it awake, so a memory-only
 * outbox dropped every exchange captured while douzed was stopped — silently, and exactly in the
 * case it exists to cover.
 */
socket.outbox.onChange = (messages) => {
  void chrome.storage.session.set({ outbox: messages })
}

// --- state ----------------------------------------------------------------

async function loadSettings(): Promise<void> {
  const local = await chrome.storage.local.get(['port', 'token', 'noise_hosts'])
  const extraHosts = Array.isArray(local['noise_hosts']) ? (local['noise_hosts'] as string[]) : []
  settings = {
    port: typeof local['port'] === 'number' ? local['port'] : DEFAULT_PORT,
    token: typeof local['token'] === 'string' ? local['token'] : '',
    noiseHosts: extraHosts,
  }
  noise = { hosts: [...NOISE_HOSTS, ...extraHosts] }
  socket.configure({
    port: settings.port,
    token: settings.token,
    version: VERSION,
    onMessage: (m) => void onServerMessage(m),
  })
}

/**
 * Every write to the stored endpoint runs here, one at a time.
 *
 * Pairing is a probe followed by a write, and boot, `onInstalled` and the reconnect alarm can all
 * start one at once. Interleaved, the slowest probe's answer lands last and wins — so the endpoint
 * we end up on is whichever daemon happened to reply slowest, not the one we chose. Serialising
 * makes the last endpoint *asked for* the one we keep.
 */
let endpointWrites: Promise<unknown> = Promise.resolve()
function serializeEndpointWrite<T>(work: () => Promise<T>): Promise<T> {
  const next = endpointWrites.then(work, work)
  endpointWrites = next.catch(() => {})
  return next
}

/**
 * The user never sees a port or a token: we ask the daemon for one. The daemon reissues its token
 * on every restart, so this runs on boot and on every reconnect alarm until the socket is up.
 */
const ensurePaired = (): Promise<void> => serializeEndpointWrite(pairNow)

async function pairNow(): Promise<void> {
  if (!needsPairing({ token: settings.token, connected: socket.connected })) return
  // Re-pairing while merely disconnected is what repairs a token the daemon has since reissued.
  // The stored port is tried first, so a run pinned to an ephemeral port keeps talking to its own
  // daemon; the ladder is only walked once that port answers nothing at all.
  const before = settings
  const paired = await pairAny(before.port)
  // Storage, not `settings`: a write that has already landed is not in `settings` until its
  // `loadSettings` runs, so comparing the in-memory object lets a probe started beforehand
  // persist the wrong daemon and re-point the next reconnect at it.
  if (paired && (paired.token !== before.token || paired.port !== before.port)) {
    const stored = await chrome.storage.local.get(['port', 'token'])
    const unchanged = (stored['token'] ?? '') === before.token && (stored['port'] ?? DEFAULT_PORT) === before.port
    if (unchanged) {
      await chrome.storage.local.set(paired)
      await loadSettings()
    }
  }
  socket.connect()
}

/** Session state lives in `chrome.storage.session`: module globals die with the worker. */
const hydrated = (async () => {
  await loadSettings()
  const session = await chrome.storage.session.get(['recording', 'outbox'])
  recording = (session['recording'] as Recording | undefined) ?? null
  const buffered = session['outbox']
  if (Array.isArray(buffered)) socket.outbox.restore(buffered as ClientMessage[])
  void ensurePaired()
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

// --- capture --------------------------------------------------------------

function emit(draft: ExchangeDraft): void {
  if (!recording) return
  if (!admits(draft, noise)) return
  const gesture = draft.gesture ?? (draft.tab_id === undefined ? undefined : lastGesture.get(draft.tab_id))
  const exchange = finalize(
    draft,
    { session_id: recording.session.id, position: recording.position, gesture },
    crypto.randomUUID(),
  )
  recording.position += 1
  recording.count += 1
  if (exchange.origin && !recording.seenOrigins.includes(exchange.origin)) {
    recording.seenOrigins.push(exchange.origin)
  }
  socket.send({ type: 'exchange.append', exchange })
  void persist()
  void paintBadge()
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
      persistAcrossSessions: true,
    },
    {
      id: 'douze-bridge',
      js: ['bridge.js'],
      world: 'ISOLATED',
      runAt: 'document_start',
      matches,
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
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
  const session: CaptureSession = {
    id: crypto.randomUUID(),
    // An unnamed session is named after the site rather than refused: the name is a label.
    name: command.name.trim() || new URL(primary).hostname,
    origins: command.origins,
    started_at: Date.now(),
    debugger_enabled: command.useDebugger,
  }
  recording = { session, tabId, position: 0, annotatedThrough: 0, count: 0, seenOrigins: [] }
  await persist()
  await registerScripts(session.origins)
  socket.send({ type: 'exchange.session.start', session })
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
  if (recording) {
    socket.send({ type: 'exchange.session.stop', session_id: recording.session.id, retained: recording.count })
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

/** AC-CAP-007.1 / .2 — the note covers every exchange since the previous note. */
function annotate(note: string): void {
  if (!recording || !note.trim()) return
  const span: AnnotationSpan = {
    id: crypto.randomUUID(),
    session_id: recording.session.id,
    note: note.trim(),
    start_position: recording.annotatedThrough,
    end_position: Math.max(recording.annotatedThrough, recording.position - 1),
  }
  recording.annotatedThrough = recording.position
  socket.send({ type: 'exchange.annotate', span })
  void persist()
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

// --- review ---------------------------------------------------------------

/**
 * Inference is expensive and every command names its session, so the session is built once and
 * kept. It is in-memory only.
 *
 * ponytail: a worker Chrome respawns mid-review loses unsaved edits and approvals, and the page
 * silently rebuilds from the capture. Persist the session if anyone ever loses work to it.
 */
const reviews = new Map<string, ReviewSession>()
let stores: Promise<{ captures: CaptureStore; recipes: RecipeStore }> | undefined

const openStores = (): Promise<{ captures: CaptureStore; recipes: RecipeStore }> => {
  stores ??= Promise.all([CaptureStore.open(), RecipeStore.open()]).then(([captures, recipes]) => ({
    captures,
    recipes,
  }))
  return stores
}

async function reviewSession(sessionId: string): Promise<ReviewSession> {
  const open = reviews.get(sessionId)
  if (open) return open
  const session = await ReviewSession.open(sessionId, await openStores())
  reviews.set(sessionId, session)
  return session
}

async function onReviewCommand(command: ReviewCommand): Promise<ReviewState | ReviewSaved | { ok: true }> {
  const session = await reviewSession(command.sessionId)
  if (command.type === 'douze:review:load') {
    return { site: session.site(), recipe: session.recipeName(), candidates: session.candidates() }
  }
  if (command.type === 'douze:review:edit') {
    session.edit(command.name, command.field, command.value)
    // AC-REC-002.2 — the edit reaches the recipe immediately, so the surface picks it up without
    // the user remembering to press anything.
    await session.save()
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

// --- connect --------------------------------------------------------------

/**
 * T-015.10 owns the real attachment: pairing credential in extension storage, the link shown once,
 * rotate and disconnect. Until then the page renders its setup screen and its trust disclosure,
 * and every action is refused by name rather than half-done.
 */
const NOT_CONNECTED_YET = 'Connecting to a hosted assistant is not wired up yet.'

const connectState = (): ConnectState => ({
  configured: false,
  url: '',
  mcp_url: '',
  allow_writes: false,
  connected: false,
})

const onConnectCommand = (command: ConnectCommand): ConnectState =>
  command.type === 'douze:connect:status'
    ? connectState()
    : { ...connectState(), error: NOT_CONNECTED_YET }

const status = (): PopupStatus => ({
  session: recording
    ? { id: recording.session.id, name: recording.session.name, origins: recording.session.origins }
    : null,
  count: recording?.count ?? 0,
  seenOrigins: recording?.seenOrigins ?? [],
  connected: socket.connected,
  port: settings.port,
  token: settings.token,
  noiseHosts: settings.noiseHosts,
})

// --- relay ----------------------------------------------------------------

async function onServerMessage(message: ServerMessage): Promise<void> {
  if (message.type !== 'relay.request') return
  // Never replay through the tab being recorded: the oracle would ingest our own request.
  const response = await executeRelay(message.request, {
    notifyExpired,
    recordingTabId: recording?.tabId,
  })
  socket.send({ type: 'relay.response', id: message.request.id, response })
}

const hostnameOf = (origin: string): string => {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}

/** AC-EXE-002.3 — link the user straight at the target's login page. */
function notifyExpired(origin: string, loginUrl: string): void {
  const id = `douze-expired-${origin}`
  // The user knows the site by its name in the address bar, not by a scheme and a port.
  const site = hostnameOf(origin)
  expiredNotifications.set(id, loginUrl)
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon128.png'),
    title: `Signed out of ${site}`,
    message: `You've been signed out of ${site}, so Douze can't act there. Click to sign in again.`,
  })
}

// --- listeners (top level, synchronous) -----------------------------------

type Inbound = CaptureBatch | PopupCommand | ReviewCommand | ConnectCommand

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
  void hydrated
    .then(async () => {
      // The pages come first: they are the only senders that are not the popup, and every one of
      // their commands names its own session rather than reading the worker's live state.
      if (message.type.startsWith('douze:review:')) return onReviewCommand(message as ReviewCommand)
      if (message.type.startsWith('douze:connect:')) return onConnectCommand(message as ConnectCommand)
      if (message.type === 'douze:start') return startSession(message)
      if (message.type === 'douze:stop') return stopSession()
      if (message.type === 'douze:annotate') {
        annotate(message.note)
        return status()
      }
      if (message.type === 'douze:noise') {
        await chrome.storage.local.set({ noise_hosts: message.hosts })
        return status()
      }
      if (message.type === 'douze:review') {
        await openReview(message.sessionId)
        return status()
      }
      if (message.type === 'douze:connect') {
        await openConnect()
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

// The alarm is the resurrection mechanism: if the socket dies while the worker is dead, no
// setTimeout exists to fire. `connect()` is idempotent, so a healthy connection makes it a no-op.
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void hydrated.then(ensurePaired)
})

chrome.runtime.onStartup.addListener(() => void hydrated.then(ensurePaired))

// Dynamic registrations are wiped on every extension update and reload.
chrome.runtime.onInstalled.addListener(() => {
  void hydrated.then(async () => {
    await DebuggerCapture.clearZombies()
    if (recording) await registerScripts(recording.session.origins)
    await ensurePaired()
  })
})

// `connect()` is idempotent, so this picks up a token written from anywhere without ever
// interrupting a healthy socket — a caller that means to re-dial closes it first.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return
  void hydrated.then(async () => {
    await loadSettings()
    socket.connect()
  })
})

chrome.notifications.onClicked.addListener((id) => {
  const url = expiredNotifications.get(id)
  if (!url) return
  expiredNotifications.delete(id)
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
    async connect(port: number, token: string): Promise<void> {
      await hydrated
      // Through the same queue as pairing: boot's probe is already in flight by the time a spec
      // calls this, and whichever writes last owns the endpoint.
      await serializeEndpointWrite(async () => {
        await chrome.storage.local.set({ port, token })
        await loadSettings()
        socket.close()
        socket.connect()
      })
    },
    isConnected: (): boolean => socket.connected,
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
      const retained = recording?.count ?? 0
      await stopSession()
      return { retained }
    },
    async annotate(note: string): Promise<void> {
      await hydrated
      annotate(note)
    },
    /** AC-CAP-001.3 — the text `chrome.action.setBadgeText` was last given. */
    badgeCount: (): number => Number(painted || 0),
    /** Exchanges captured but not yet accepted by the socket. */
    pendingCount: (): number => socket.outbox.size,
    /** The queued messages themselves, so a spec can assert without a daemon attached. */
    pending: (): ClientMessage[] => socket.outbox.snapshot(),
    /**
     * Whether the origin is granted. It cannot be granted from here: `permissions.request`
     * needs a user gesture, so the e2e build bakes the origin in via `DOUZE_TEST_ORIGIN`.
     */
    hasOrigin: (origin: string): Promise<boolean> =>
      chrome.permissions.contains({ origins: [`${origin}/*`] }),
    status,
  },
})
