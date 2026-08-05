import {
  DEFAULT_PORT,
  NOISE_HOSTS,
  type AnnotationSpan,
  type ClientMessage,
  type CaptureSession,
  type NoiseConfig,
  type ServerMessage,
} from '@recon/shared'
import type {
  CaptureBatch,
  GestureEvent,
  PageEvent,
  PopupCommand,
  PopupStatus,
  RequestEvent,
} from './messages.js'
import { DebuggerCapture } from './debugger-capture.js'
import { installOracle } from './oracle.js'
import { RECONCILE_GRACE_MS, Reconciler, admits, decodeBody, finalize, type ExchangeDraft } from './pipeline.js'
import { executeRelay } from './relay.js'
import { DaemonSocket } from './ws-client.js'

/**
 * T-001.4 / T-002.2 — the service worker. It owns session lifecycle, provenance attribution,
 * redaction (in `finalize`), reconciliation across capture paths, and the recond socket.
 *
 * Every listener below is registered synchronously at the top level: a listener added after an
 * `await` silently stops working once Chrome respawns the worker.
 */

const VERSION = chrome.runtime.getManifest().version
const RECONCILE_IDS = ['recon-main', 'recon-bridge']
const RECONNECT_ALARM = 'recon-reconnect'

interface Recording {
  session: CaptureSession
  tabId: number
  /** Next position to assign; Annotation Spans index into the same sequence. */
  position: number
  annotatedThrough: number
  count: number
}

let recording: Recording | null = null
let settings = { port: DEFAULT_PORT, token: '', noiseHosts: [] as string[] }
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

/** Session state lives in `chrome.storage.session`: module globals die with the worker. */
const hydrated = (async () => {
  await loadSettings()
  const session = await chrome.storage.session.get('recording')
  recording = (session['recording'] as Recording | undefined) ?? null
  socket.connect()
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
  await chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' })
}
/** The last text handed to `setBadgeText`, so a test can assert what the badge shows. */
let painted = ''

// --- capture --------------------------------------------------------------

function emit(draft: ExchangeDraft): void {
  if (!recording) return
  if (!admits(draft, recording.session.origins, noise)) return
  const gesture = draft.gesture ?? (draft.tab_id === undefined ? undefined : lastGesture.get(draft.tab_id))
  const exchange = finalize(
    draft,
    { session_id: recording.session.id, position: recording.position, gesture },
    crypto.randomUUID(),
  )
  recording.position += 1
  recording.count += 1
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

function ingest(batch: PageEvent[], tabId: number): void {
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

    const requestBody = decodeBody(request.body, request.headers['content-type'])
    const contentType = event.headers['content-type']
    const responseBody = decodeBody(event.body, contentType)
    // For a body we cut short, the header is the honest size; ours is only what we kept.
    const declaredSize = Number(event.headers['content-length'])
    const size = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : responseBody.size
    route({
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
      id: 'recon-main',
      js: ['interceptor.js'],
      world: 'MAIN',
      runAt: 'document_start',
      matches,
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
    },
    {
      id: 'recon-bridge',
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
async function startSession(command: Extract<PopupCommand, { type: 'recon:start' }>): Promise<PopupStatus> {
  if (!command.name.trim()) throw new Error('a session name is required')
  const [primary] = command.origins
  if (!primary) throw new Error('a session needs at least one origin')
  const tabId = await resolveTab(primary, command.tabId)
  const session: CaptureSession = {
    id: crypto.randomUUID(),
    name: command.name.trim(),
    origins: command.origins,
    started_at: Date.now(),
    debugger_enabled: command.useDebugger,
  }
  recording = { session, tabId, position: 0, annotatedThrough: 0, count: 0 }
  await persist()
  await registerScripts(session.origins)
  socket.send({ type: 'exchange.session.start', session })
  // Registration does not affect an already-loaded tab, and document_start injection is the
  // whole point — patch `fetch` before page scripts capture a reference to it. Both branches
  // reload, so a caller never has to; `attach` reloads to make bodies retrievable at all.
  if (command.useDebugger) await debuggerCapture.attach(tabId).catch(() => {})
  else await chrome.tabs.reload(tabId)
  await paintBadge()
  return status()
}

/** AC-CAP-001.4 — stopping reports the count retained after filtering. */
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

const status = (): PopupStatus => ({
  session: recording
    ? { id: recording.session.id, name: recording.session.name, origins: recording.session.origins }
    : null,
  count: recording?.count ?? 0,
  connected: socket.connected,
  port: settings.port,
  token: settings.token,
  noiseHosts: settings.noiseHosts,
})

// --- relay ----------------------------------------------------------------

async function onServerMessage(message: ServerMessage): Promise<void> {
  if (message.type !== 'relay.request') return
  const response = await executeRelay(message.request, { notifyExpired })
  socket.send({ type: 'relay.response', id: message.request.id, response })
}

/** AC-EXE-002.3 — link the user straight at the target's login page. */
function notifyExpired(origin: string, loginUrl: string): void {
  const id = `recon-expired-${origin}`
  expiredNotifications.set(id, loginUrl)
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon128.png'),
    title: 'Recon: session expired',
    message: `Your session for ${origin} has expired. Click to sign in again.`,
  })
}

// --- listeners (top level, synchronous) -----------------------------------

chrome.runtime.onMessage.addListener((message: CaptureBatch | PopupCommand, sender, sendResponse) => {
  if (message.type === 'recon:capture') {
    const tabId = sender.tab?.id
    // Everything arriving from a content script is attacker-controlled: a page can forge these,
    // so the frame's own origin — not anything in the message — decides whether we listen.
    if (tabId === undefined) return undefined
    void hydrated.then(() => {
      if (!recording || !recording.session.origins.includes(sender.origin ?? '')) return
      ingest(message.batch.slice(0, 200), tabId)
    })
    return undefined
  }
  void hydrated
    .then(async () => {
      if (message.type === 'recon:start') return startSession(message)
      if (message.type === 'recon:stop') return stopSession()
      if (message.type === 'recon:annotate') {
        annotate(message.note)
        return status()
      }
      if (message.type === 'recon:noise') {
        await chrome.storage.local.set({ noise_hosts: message.hosts })
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
  if (alarm.name === RECONNECT_ALARM) void hydrated.then(() => socket.connect())
})

chrome.runtime.onStartup.addListener(() => void hydrated.then(() => socket.connect()))

// Dynamic registrations are wiped on every extension update and reload.
chrome.runtime.onInstalled.addListener(() => {
  void hydrated.then(async () => {
    await DebuggerCapture.clearZombies()
    if (recording) await registerScripts(recording.session.origins)
    socket.connect()
  })
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  const reconnect = Boolean(changes['port'] ?? changes['token'])
  void hydrated.then(async () => {
    await loadSettings()
    if (!reconnect) return
    socket.close()
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
  __recon: {
    async connect(port: number, token: string): Promise<void> {
      await hydrated
      await chrome.storage.local.set({ port, token })
      await loadSettings()
      socket.close()
      socket.connect()
    },
    isConnected: (): boolean => socket.connected,
    async startSession(
      name: string,
      origins: string[],
      opts: { debugger?: boolean; tabId?: number } = {},
    ): Promise<string> {
      await hydrated
      await startSession({
        type: 'recon:start',
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
     * needs a user gesture, so the e2e build bakes the origin in via `RECON_TEST_ORIGIN`.
     */
    hasOrigin: (origin: string): Promise<boolean> =>
      chrome.permissions.contains({ origins: [`${origin}/*`] }),
    status,
  },
})
