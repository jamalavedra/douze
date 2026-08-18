import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Recipe, codeKey, mintNonce, mintSalt, proof, secretHashKey, sha256Hex } from '@douze/shared'
import type { RelayPairing } from './attach.js'
import { DISPATCHERS } from './guards.js'
import type { ConnectState, DataState, PageEvent, ReviewState } from './messages.js'
import { RecipeStore } from './recipes.js'
import { ReviewSession } from './review-session.js'
import { CaptureStore } from './store.js'
import { installFakeIndexedDB, uninstallFakeIndexedDB } from './testing.js'

/**
 * WO-015 T-015.1 — the service worker recorded into its own store, driven the way Chrome drives
 * it: through the message listener it registers at the top level.
 *
 * No jsdom and no browser, as everywhere else in this package: `chrome.*` and `indexedDB` are
 * installed on `globalThis` for the duration of a test. The IndexedDB is `testing.ts`'s fake,
 * because the point here is that a real `CaptureStore` is written and read back — it covers
 * exactly what `store.ts` uses (compound indexes, bound ranges, a backwards key cursor) and
 * proves nothing about a real browser's transaction lifetimes or quota.
 *
 * `vi.resetModules()` before each import is what makes the worker fresh: the module registers its
 * listeners and starts its `hydrated` promise at import time, exactly as Chrome respawning it does.
 */

// --- chrome fake -----------------------------------------------------------

type Handler = (...args: never[]) => unknown

interface FakeEvent {
  addListener: (handler: Handler) => void
  removeListener: (handler: Handler) => void
  emit: (...args: unknown[]) => unknown[]
}

const fakeEvent = (): FakeEvent => {
  const handlers = new Set<Handler>()
  return {
    addListener: (handler) => {
      handlers.add(handler)
    },
    removeListener: (handler) => {
      handlers.delete(handler)
    },
    emit: (...args) => [...handlers].map((handler) => handler(...(args as never[]))),
  }
}

type Changes = Record<string, { newValue?: unknown; oldValue?: unknown }>

const storageArea = (items: Map<string, unknown>, area: string, onChanged: FakeEvent) => ({
  getKeys: async (): Promise<string[]> => [...items.keys()],
  get: async (keys: string | string[]): Promise<Record<string, unknown>> => {
    const wanted = typeof keys === 'string' ? [keys] : keys
    const found: Record<string, unknown> = {}
    for (const key of wanted) if (items.has(key)) found[key] = structuredClone(items.get(key))
    return found
  },
  set: async (values: Record<string, unknown>): Promise<void> => {
    const changes: Changes = {}
    for (const [key, value] of Object.entries(values)) {
      changes[key] = { oldValue: items.get(key), newValue: value }
      items.set(key, structuredClone(value))
    }
    queueMicrotask(() => onChanged.emit(changes, area))
  },
  // A removal notifies exactly as a write does, because Chrome's does: the recipe store's
  // `onChanged` listener is how a deleted recipe ever leaves the live surface.
  remove: async (keys: string | string[]): Promise<void> => {
    const changes: Changes = {}
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      if (!items.has(key)) continue
      changes[key] = { oldValue: items.get(key) }
      items.delete(key)
    }
    if (Object.keys(changes).length > 0) queueMicrotask(() => onChanged.emit(changes, area))
  },
})

/** What the ISOLATED-world injection hands back; a test swaps it to drive execution. */
type Injected = { status: number; headers: Record<string, string>; body: string; url: string; redirected: boolean }

interface FakeChrome {
  onMessage: FakeEvent
  onAlarm: FakeEvent
  onNotificationClicked: FakeEvent
  reloaded: number[]
  created: string[]
  badge: string
  registered: string[]
  /** The whole script objects, so a test can read the options and not only the ids. */
  scripts: Array<Record<string, unknown>>
  local: Map<string, unknown>
  alarms: string[]
  notifications: { id: string; title: string; message: string }[]
  /** Swapped by a test that needs a specific response, or a slow one. */
  inject: (url: string) => Promise<Injected>
  /** T-015.10 — the host permission the connect page asks for. Cleared to refuse it. */
  hostPermission: boolean
}

const globals = globalThis as Record<string, unknown>
/** Put back after each test: `fetch` here is Node's own, and the worker's is faked over it. */
const realFetch = globalThis.fetch

function installChrome(): FakeChrome {
  const onMessage = fakeEvent()
  const onChanged = fakeEvent()
  const local = new Map<string, unknown>()
  const session = new Map<string, unknown>()
  const state: FakeChrome = {
    onMessage,
    onAlarm: fakeEvent(),
    onNotificationClicked: fakeEvent(),
    reloaded: [],
    created: [],
    badge: '',
    registered: [],
    scripts: [],
    local,
    alarms: [],
    notifications: [],
    inject: async (url: string) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: 1 }] }),
      url,
      redirected: false,
    }),
    hostPermission: true,
  }

  globals['chrome'] = {
    runtime: {
      onMessage,
      onInstalled: fakeEvent(),
      getURL: (path: string) => `chrome-extension://douze/${path}`,
      getManifest: () => ({ version: '0.1.0' }),
    },
    alarms: {
      onAlarm: state.onAlarm,
      create: (name: string) => {
        state.alarms.push(name)
      },
    },
    notifications: {
      onClicked: state.onNotificationClicked,
      create: (id: string, options: { title: string; message: string }) => {
        state.notifications.push({ id, title: options.title, message: options.message })
      },
      clear: async () => undefined,
    },
    permissions: { contains: async () => state.hostPermission },
    storage: {
      local: storageArea(local, 'local', onChanged),
      session: storageArea(session, 'session', onChanged),
      onChanged,
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => {
        state.badge = text
      },
      setBadgeBackgroundColor: async () => undefined,
    },
    tabs: {
      onRemoved: fakeEvent(),
      query: async () => [{ id: 7, url: 'https://app.test/orders' }],
      reload: async (tabId: number) => {
        state.reloaded.push(tabId)
      },
      create: async ({ url }: { url: string }) => {
        state.created.push(url)
      },
    },
    scripting: {
      registerContentScripts: async (scripts: Array<Record<string, unknown>>) => {
        state.registered = scripts.map((script) => String(script['id']))
        state.scripts = scripts
      },
      unregisterContentScripts: async () => undefined,
      // The one injection `executeRelay` makes for a cookie-authenticated tool: the ISOLATED-world
      // fetch. `args[0]` is the URL it was told to call.
      executeScript: async ({ args }: { args?: unknown[] }) => [{ result: await state.inject(String(args?.[0] ?? '')) }],
    },
    webRequest: {
      onBeforeRequest: fakeEvent(),
      onSendHeaders: fakeEvent(),
      onCompleted: fakeEvent(),
      onErrorOccurred: fakeEvent(),
    },
  }
  return state
}

// --- WebSocket fake (T-015.8) ----------------------------------------------

/**
 * One host on the far side of an attachment. The worker dials; nothing here connects on its own,
 * so a test decides exactly when `open`, `welcome` and a drop happen — which is the only way to
 * assert on what the worker does with a call that was in flight when the socket died.
 */
class FakeSocket {
  static readonly opened: FakeSocket[] = []
  readyState = 0
  readonly sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(readonly url: string) {
    FakeSocket.opened.push(this)
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }

  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>)
  }

  close(): void {
    this.drop(1000)
  }

  /** The host accepted the socket. */
  accept(): void {
    this.readyState = 1
    this.fire('open', {})
  }

  /** One host → extension frame. `extra` rides beside it, as the bridge's `secret` does. */
  deliver(frame: unknown, extra: Record<string, unknown> = {}): void {
    this.fire('message', { data: JSON.stringify({ ...(frame as object), ...extra }) })
  }

  drop(code = 1006): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.fire('close', { code })
  }

  /** Frames of one type, in order. */
  frames(type: string): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame['type'] === type)
  }

  private fire(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

const dialled = (match: string): FakeSocket | undefined =>
  FakeSocket.opened.filter((socket) => socket.url.includes(match)).at(-1)

// --- driving the worker ----------------------------------------------------

/** A popup or an extension page. `review.html` is open in a TAB, so `sender.tab` is set here. */
const extensionPage = (tabId?: number): chrome.runtime.MessageSender => ({
  id: 'douze',
  url: 'chrome-extension://douze/review.html',
  ...(tabId === undefined ? {} : { tab: { id: tabId } as chrome.tabs.Tab }),
})

/** A content script of ours, injected into a page. Chrome fills `url` in with the page's own. */
const contentScript = (origin: string, tabId = 7): chrome.runtime.MessageSender => ({
  id: 'douze',
  tab: { id: tabId } as chrome.tabs.Tab,
  origin,
  url: `${origin}/orders`,
})

let fake: FakeChrome

/** Sends as Chrome sends: the listener's return value decides whether a reply is coming. */
const sendFrom = async (sender: chrome.runtime.MessageSender, message: unknown): Promise<unknown> =>
  new Promise((resolve) => {
    const [handled] = fake.onMessage.emit(message, sender, resolve)
    if (handled !== true) resolve(undefined)
  })

/** One macrotask drains every pending microtask, which is all the fakes and the store use. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'

/** A request/response pair as the MAIN-world interceptor batches it. */
const exchangeEvents = (
  id: string,
  method: string,
  url: string,
  extra: Partial<Record<string, unknown>> = {},
): PageEvent[] => [
  {
    type: 'request',
    id,
    kind: 'fetch',
    url,
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? null : { text: JSON.stringify({ item: 'lamp' }) },
    t: 1000,
    ...extra,
  } as PageEvent,
  {
    type: 'response',
    id,
    status: 200,
    url,
    headers: { 'content-type': 'application/json' },
    body: { text: JSON.stringify({ orders: [{ id: 1, total: 12 }] }) },
    t: 1050,
  },
]

/** One approved tool on `api.test` — the minimum that reaches the Tool Surface. */
const SHOP_RECIPE = Recipe.parse({
  version: 1,
  name: 'shop',
  target: { base_url: 'https://api.test' },
  tools: [
    {
      name: 'list_orders',
      description: 'List orders',
      side_effect: 'read',
      confidence: 0.9,
      observations: 3,
      approved: true,
      request: { method: 'GET', path: '/orders' },
      fixtures: ['shop/list_orders.json'],
    },
  ],
})

interface DouzeSurface {
  startSession: (name: string, origins: string[], opts?: { tabId?: number }) => Promise<string>
  stopSession: () => Promise<{ retained: number }>
  annotate: (note: string) => Promise<void>
  badgeCount: () => number
  recorded: (sessionId: string) => Promise<{ exchanges: unknown[]; annotations: unknown[] }>
  status: () => { session: { id: string } | null; count: number; noiseHosts: string[] }
}

const douze = (): DouzeSurface => globals['__douze'] as DouzeSurface

// --- the relay's HTTP API (T-015.10) ---------------------------------------

interface RelayCall {
  url: string
  method: string
  token?: string
  body?: unknown
}

/** Every call the worker made to a relay's own API, in order. */
const relayCalls: RelayCall[] = []
/** What the relay answers next. Swapped by a test that needs a refusal or an outage. */
let relayAnswer: (call: RelayCall) => { status: number; body?: unknown } = () => ({
  status: 201,
  body: { token: 'minted-token', mcp_path: '/m/minted' },
})

const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
  const call: RelayCall = {
    url,
    method: init.method,
    ...(init.headers['x-douze-relay-token'] === undefined
      ? {}
      : { token: init.headers['x-douze-relay-token'] }),
    ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }),
  }
  relayCalls.push(call)
  const answer = relayAnswer(call)
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    json: async () => answer.body,
  }
}

/** `seed` lands in `chrome.storage.local` BEFORE the worker starts, as a stored pairing does. */
async function bootWorker(seed: Record<string, unknown> = {}): Promise<void> {
  installFakeIndexedDB()
  fake = installChrome()
  FakeSocket.opened.length = 0
  relayCalls.length = 0
  relayAnswer = () => ({ status: 201, body: { token: 'minted-token', mcp_path: '/m/minted' } })
  globals['fetch'] = fakeFetch
  for (const [key, value] of Object.entries(seed)) fake.local.set(key, value)
  globals['WebSocket'] = FakeSocket
  vi.resetModules()
  await import('./background.js')
  await settle()
}

const capture = async (events: PageEvent[], origin = 'https://app.test'): Promise<void> => {
  await sendFrom(contentScript(origin), { type: 'douze:capture', batch: events })
}

const openCaptures = (): Promise<CaptureStore> => CaptureStore.open()

beforeEach(() => bootWorker())

afterEach(() => {
  delete globals['chrome']
  uninstallFakeIndexedDB()
  delete globals['WebSocket']
  globals['fetch'] = realFetch
  delete globals['__douze']
})

describe('a session recorded with no daemon anywhere (T-015.1)', () => {
  it('lands in the capture store in the order the pipeline produced it', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    await capture(exchangeEvents('r1', 'GET', 'https://app.test/api/orders'))
    await capture(exchangeEvents('r2', 'POST', 'https://app.test/api/orders'))
    await capture(exchangeEvents('r3', 'GET', 'https://app.test/api/orders/42'))
    await settle()

    const detail = await (await openCaptures()).session(id)
    expect(detail?.exchanges.map((e) => [e.position, e.method, e.url])).toEqual([
      [0, 'GET', 'https://app.test/api/orders'],
      [1, 'POST', 'https://app.test/api/orders'],
      [2, 'GET', 'https://app.test/api/orders/42'],
    ])
    // The tab was reloaded so `document_start` injection could happen at all, and both content
    // scripts were registered for the origin the session named.
    expect(fake.reloaded).toEqual([7])
    expect(fake.registered).toEqual(['douze-main', 'douze-bridge'])
  })

  it('is readable by ReviewSession, which is the whole point of storing it', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    for (const n of [1, 2, 3]) await capture(exchangeEvents(`r${n}`, 'GET', 'https://app.test/api/orders'))
    await capture(exchangeEvents('w1', 'POST', 'https://app.test/api/orders'))
    await douze().stopSession()

    const review = await ReviewSession.open(id, { captures: await openCaptures(), recipes: await RecipeStore.open() })
    expect(review.site()).toBe('app.test')
    expect(review.recipeName()).toBe('shop')
    expect(review.candidates().length).toBeGreaterThan(0)
  })

  it('marks the session stopped and reports what survived', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    await capture(exchangeEvents('r1', 'GET', 'https://app.test/api/orders'))
    await capture(exchangeEvents('r2', 'GET', 'https://app.test/api/orders/42'))
    await settle()
    expect(douze().badgeCount()).toBe(2)

    expect(await douze().stopSession()).toEqual({ retained: 2 })
    const detail = await (await openCaptures()).session(id)
    expect(detail?.session.stopped_at).toBeGreaterThan(0)
    // The badge clears and the popup stops claiming a live session.
    expect(douze().badgeCount()).toBe(0)
    expect(douze().status().session).toBeNull()
  })

  it('attaches a note to the exchanges captured since the previous one', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    await capture(exchangeEvents('r1', 'GET', 'https://app.test/api/orders'))
    await capture(exchangeEvents('r2', 'POST', 'https://app.test/api/orders'))
    await douze().annotate('creates an order')
    await capture(exchangeEvents('r3', 'GET', 'https://app.test/api/orders/42'))
    await douze().annotate('opens one')

    const { annotations } = await douze().recorded(id)
    expect(annotations).toEqual([
      expect.objectContaining({ note: 'creates an order', start_position: 0, end_position: 1 }),
      expect.objectContaining({ note: 'opens one', start_position: 2, end_position: 2 }),
    ])
  })

  /**
   * The credential hints come from the page, which is attacker-controlled, and redaction does not
   * walk them — so a hint carrying the value itself is stopped only by the store's gate. It must
   * fail closed: nothing stored, and the count must not claim an exchange that is not there.
   */
  it('drops an exchange the store refuses rather than counting it', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    await capture(
      exchangeEvents('bad', 'GET', 'https://app.test/api/orders', {
        credentials: [{ header: 'authorization', expression: JWT, prefix: 'Bearer ' }],
      }),
    )
    await capture(exchangeEvents('ok', 'GET', 'https://app.test/api/orders/42'))
    await settle()

    const { exchanges } = await douze().recorded(id)
    expect(exchanges).toHaveLength(1)
    expect(JSON.stringify(exchanges)).not.toContain(JWT)
    expect(douze().badgeCount()).toBe(1)
    expect((await douze().stopSession()).retained).toBe(1)
  })

  it('ignores a batch from an origin the session never named', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    await capture(exchangeEvents('r1', 'GET', 'https://evil.test/api/steal'), 'https://evil.test')
    await settle()
    expect((await douze().recorded(id)).exchanges).toHaveLength(0)
  })

  /**
   * The registration and the state that justifies it must not outlive each other. `recording`
   * lives in `chrome.storage.session`, which Chrome clears on browser restart; a persistent
   * registration survived that, so every recorded origin kept a patched `fetch` and an injected
   * bridge with nothing left that knew why — and no `onStartup` listener to reconcile them.
   */
  it('registers the content scripts for this browser session only, as the recording state is', async () => {
    await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    expect(fake.scripts.map((script) => [script['id'], script['persistAcrossSessions']])).toEqual([
      ['douze-main', false],
      ['douze-bridge', false],
    ])
  })
})

/**
 * The internal-page routes change state and hand back captured data, and `chrome.runtime.onMessage`
 * delivers a content script's `sendMessage` to exactly the same listener. `sender.tab === undefined`
 * is NOT the discriminator: an extension page open in a tab has `sender.tab` set too, so that test
 * would refuse the review page and admit nothing extra.
 */
describe('messages from anything but an extension page (security)', () => {
  const forged = contentScript('https://evil.test')

  it('refuses a forged session start, with no reply and nothing recorded', async () => {
    expect(await sendFrom(forged, { type: 'douze:start', name: 'x', origins: ['https://evil.test'] })).toBeUndefined()
    await settle()
    expect(douze().status().session).toBeNull()
    expect(await (await openCaptures()).sessions()).toEqual([])
  })

  it('refuses a forged read of a capture', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    await capture(exchangeEvents('r1', 'GET', 'https://app.test/api/orders'))
    await settle()
    expect(await sendFrom(forged, { type: 'douze:review:load', sessionId: id })).toBeUndefined()
  })

  it('refuses a forged stop, a forged note and a forged status', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    await capture(exchangeEvents('r1', 'GET', 'https://app.test/api/orders'))
    await settle()

    expect(await sendFrom(forged, { type: 'douze:annotate', note: 'forged' })).toBeUndefined()
    expect(await sendFrom(forged, { type: 'douze:stop' })).toBeUndefined()
    expect(await sendFrom(forged, { type: 'douze:status' })).toBeUndefined()
    await settle()

    expect(douze().status().session?.id).toBe(id)
    expect((await douze().recorded(id)).annotations).toEqual([])
  })

  it('serves the review page, which is an extension page open in a tab', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    for (const n of [1, 2, 3]) await capture(exchangeEvents(`r${n}`, 'GET', 'https://app.test/api/orders'))
    await douze().stopSession()

    const state = (await sendFrom(extensionPage(11), { type: 'douze:review:load', sessionId: id })) as {
      site: string
      candidates: unknown[]
    }
    expect(state.site).toBe('app.test')
    expect(state.candidates.length).toBeGreaterThan(0)
  })

  it('serves the popup, which is an extension page with no tab at all', async () => {
    const status = (await sendFrom(extensionPage(), { type: 'douze:status' })) as { session: null; count: number }
    expect(status).toMatchObject({ session: null, count: 0 })
  })
})

describe('what the popup asks the worker for', () => {
  it('opens the two pages itself, because a permission prompt closes the popup', async () => {
    await sendFrom(extensionPage(), { type: 'douze:review', sessionId: 's1' })
    await sendFrom(extensionPage(), { type: 'douze:connect' })
    expect(fake.created).toEqual([
      'chrome-extension://douze/review.html?session=s1',
      'chrome-extension://douze/connect.html',
    ])
  })

  it('answers with the tools already set up on the site, from the recipe store', async () => {
    const recipes = await RecipeStore.open()
    await recipes.putFixture('shop', 'list_orders', { tool: 'list_orders' })
    const saved = await recipes.save(SHOP_RECIPE)
    expect(saved.ok, saved.error).toBe(true)
    await settle()

    const here = (await sendFrom(extensionPage(), {
      type: 'douze:site-tools',
      origin: 'https://api.test',
    })) as { tools: Array<{ name: string; side_effect: string }> }
    expect(here.tools).toEqual([
      { name: 'shop_list_orders', description: 'List orders', side_effect: 'read' },
    ])

    // A site with nothing set up on it says so with an empty list, not with the other site's tools.
    const elsewhere = (await sendFrom(extensionPage(), {
      type: 'douze:site-tools',
      origin: 'https://other.test',
    })) as { tools: unknown[] }
    expect(elsewhere.tools).toEqual([])
  })

  it('reports the noise hosts it just saved', async () => {
    const status = (await sendFrom(extensionPage(), {
      type: 'douze:noise',
      hosts: ['metrics.internal.example'],
    })) as { noiseHosts: string[] }
    expect(status.noiseHosts).toEqual(['metrics.internal.example'])
    expect(fake.local.get('noise_hosts')).toEqual(['metrics.internal.example'])
  })
})

/**
 * WO-015 T-015.8/9 — the attachment client and the guards, driven the way a host drives them:
 * frames onto the socket the worker dialled. The far side is faked at the socket and nothing below
 * it is, so the recipe store, `runToolCall` and `executeRelay` are all the real ones.
 */

const RELAY = { url: 'https://relay.test', token: 'relay-token', mcp_path: '/m/secret', allow_writes: false }

/** Three tools on `app.test`, one of each side effect — the whole trust table in one recipe. */
const SHOP_ALL = Recipe.parse({
  version: 1,
  name: 'shop',
  target: { base_url: 'https://app.test' },
  tools: [
    {
      name: 'list_orders',
      description: 'List orders',
      side_effect: 'read',
      confidence: 0.9,
      observations: 3,
      approved: true,
      request: { method: 'GET', path: '/orders' },
      response: { primary_payload_path: '$.data' },
      fixtures: ['shop/list_orders.json'],
    },
    {
      name: 'create_order',
      description: 'Create an order',
      side_effect: 'write',
      confidence: 0.9,
      observations: 3,
      approved: true,
      request: {
        method: 'POST',
        path: '/orders',
        input_schema: { type: 'object', properties: { item: { type: 'string' } } },
      },
      fixtures: ['shop/create_order.json'],
    },
    {
      name: 'delete_order',
      description: 'Delete an order',
      side_effect: 'destructive',
      confidence: 0.9,
      observations: 3,
      approved: true,
      request: {
        method: 'DELETE',
        path: '/orders/{id}',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' }, confirm: { type: 'boolean' } },
          required: ['id', 'confirm'],
        },
      },
      fixtures: ['shop/delete_order.json'],
    },
  ],
})

/** Puts the recipe and its fixtures in storage, which is what moves the surface. */
async function approveShop(): Promise<void> {
  const recipes = await RecipeStore.open()
  for (const tool of ['list_orders', 'create_order', 'delete_order']) {
    await recipes.putFixture('shop', tool, { ok: true })
  }
  const saved = await recipes.save(SHOP_ALL)
  expect(saved.ok, saved.error).toBe(true)
  await settle()
}

/** Recipe tool names per push; the dispatchers ride on every surface. See LIST_SKILLS in guards.ts. */
const pushedNames = (socket: FakeSocket): string[][] =>
  socket
    .frames('surface.push')
    .map((frame) => (frame['tools'] as { name: string }[]).map((tool) => tool.name))
    .map((names) => names.filter((name) => !DISPATCHERS.includes(name)))

/**
 * The bridge's half of the loopback handshake (T-015.12), computed the way a real bridge computes
 * it — over the extension's own nonce, the bridge's, and the port that was dialled.
 *
 * A test that wants to be a rogue passes `tricks.proof`: something that answered the port without
 * holding the credential can put any bytes it likes here, and that is exactly the case the
 * extension has to survive.
 */
const challenge = async (
  socket: FakeSocket,
  credential: { code?: string; secret?: string },
  tricks: { proof?: string; nonce?: string; salt?: string } = {},
): Promise<{ nonce: string; proof: string; salt: string }> => {
  const hello = socket.frames('hello')[0] ?? {}
  const extensionNonce = String(hello['nonce'] ?? '')
  const bridgeNonce = tricks.nonce ?? mintNonce()
  const port = Number(new URL(socket.url).port)
  // A bridge running on a code salts it per process and says so here; one running on the stored
  // secret stretches nothing and sends no salt at all.
  const salt = credential.secret === undefined ? (tricks.salt ?? mintSalt()) : ''
  const key =
    credential.secret === undefined
      ? await codeKey(credential.code ?? '', salt)
      : await secretHashKey(await sha256Hex(credential.secret))
  const frame = {
    type: 'bridge.challenge',
    nonce: bridgeNonce,
    ...(salt ? { salt } : {}),
    proof: tricks.proof ?? (await proof(key, { role: 'bridge', port, extensionNonce, bridgeNonce, salt })),
  }
  socket.deliver(frame)
  // The proof is Web Crypto, so the worker answers a macrotask or several later, not synchronously.
  await until(() => socket.frames('bridge.proof').length > 0)
  return { nonce: bridgeNonce, proof: frame.proof, salt }
}

/** Waits for something the worker does asynchronously, or gives up and lets the assertion fail. */
const until = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
}

/**
 * Boots a worker with a stored pairing and takes the socket it dialled through the handshake.
 * `bridge` is the credential the far side is to prove it holds; without it nothing is proved, which
 * is what a rogue on the port amounts to.
 */
async function attach(
  seed: Record<string, unknown>,
  match: string,
  bridge?: { code?: string; secret?: string },
): Promise<FakeSocket> {
  await bootWorker(seed)
  const socket = dialled(match)
  if (!socket) throw new Error(`nothing dialled ${match}; saw ${FakeSocket.opened.map((s) => s.url).join(', ')}`)
  socket.accept()
  await settle()
  if (bridge) await challenge(socket, bridge)
  socket.deliver({ type: 'welcome', heartbeat_ms: 20_000 })
  await settle()
  return socket
}

const callFrame = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  trust = 'remote',
): Record<string, unknown> => ({ type: 'tool.call', id, name, args, trust })

const resultFor = (socket: FakeSocket, id: string): Record<string, unknown> | undefined =>
  socket.frames('tool.result').find((frame) => frame['id'] === id)

const failure = (socket: FakeSocket, id: string): { code: string; message: string } =>
  resultFor(socket, id)?.['error'] as { code: string; message: string }

describe('the attachment handshake (T-015.8)', () => {
  it('recreates the reconnect alarm at every worker start, because an evicted one keeps no timers', () => {
    expect(fake.alarms).toContain('douze-attach')
  })

  it('says hello with the stored endpoint token and its own version, then pushes the surface', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    expect(socket.url).toBe('wss://relay.test/ws')
    expect(socket.frames('hello')[0]).toEqual({
      type: 'hello',
      extension_version: '0.1.0',
      token: 'relay-token',
    })
    // Pushed on connect even when it is empty: the host caches it, and nothing else corrects it.
    expect(pushedNames(socket)).toEqual([[]])
  })

  it('answers a ping with a pong', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    socket.deliver({ type: 'ping' })
    await settle()
    expect(socket.frames('pong')).toHaveLength(1)
  })

  it('pushes again on every recipe change, and again on the next connect', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    expect(pushedNames(socket).at(-1)).toEqual(['shop_list_orders'])

    // The socket dies with the host, not with the pairing: the alarm re-dials and re-pushes,
    // because a host that came back holds no surface at all until this arrives.
    socket.drop()
    fake.onAlarm.emit({ name: 'douze-attach' })
    await settle()
    const second = dialled('relay.test') as FakeSocket
    expect(second).not.toBe(socket)
    second.accept()
    await settle()
    second.deliver({ type: 'welcome', heartbeat_ms: 20_000 })
    await settle()
    expect(pushedNames(second).at(-1)).toEqual(['shop_list_orders'])
  })
})

describe('the trust table, enforced in the extension (T-015.9)', () => {
  it('never pushes a destructive tool to a remote host, and refuses one a lying host asks for', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    expect(pushedNames(socket).at(-1)).toEqual(['shop_list_orders'])

    // `trust: 'local'` is the host's claim; the extension derives its own from what it dialled.
    socket.deliver(callFrame('c1', 'shop_delete_order', { id: '7', confirm: true }, 'local'))
    await settle()
    expect(resultFor(socket, 'c1')?.['result']).toBeUndefined()
    expect(failure(socket, 'c1').code).toBe('trust_refused')
    expect(failure(socket, 'c1').message).toContain('no setting that turns it on')
  })

  it('refuses a remote write until the attachment opted in, then pushes and runs it', async () => {
    const readOnly = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    readOnly.deliver(callFrame('w1', 'shop_create_order', { item: 'lamp' }))
    await settle()
    expect(failure(readOnly, 'w1').code).toBe('trust_refused')

    const allowed = await attach({ 'attach:relay': { ...RELAY, allow_writes: true } }, 'relay.test')
    await approveShop()
    expect(pushedNames(allowed).at(-1)).toEqual(['shop_list_orders', 'shop_create_order'])
    allowed.deliver(callFrame('w2', 'shop_create_order', { item: 'lamp' }))
    await settle()
    expect(resultFor(allowed, 'w2')?.['error']).toBeUndefined()
  })

  it('gives a proved local bridge everything, and asks a destructive tool for confirm', async () => {
    const socket = await attach({ 'attach:bridge': { secret: 'pinned-secret' } }, '127.0.0.1', {
      secret: 'pinned-secret',
    })
    await approveShop()
    expect(pushedNames(socket).at(-1)).toEqual(['shop_list_orders', 'shop_create_order', 'shop_delete_order'])
    // The credential is not on the wire: hello carries this dial's nonce and nothing else, and the
    // answer to the challenge is an HMAC over it.
    expect(socket.frames('hello')[0]).toEqual({
      type: 'hello',
      extension_version: '0.1.0',
      nonce: expect.stringMatching(/^[\w-]{43}$/) as unknown as string,
    })
    expect(JSON.stringify(socket.sent)).not.toContain('pinned-secret')

    socket.deliver(callFrame('d1', 'shop_delete_order', { id: '7' }, 'remote'))
    socket.deliver(callFrame('d2', 'shop_delete_order', { id: '7', confirm: true }, 'remote'))
    await settle()
    expect(failure(socket, 'd1').code).toBe('confirm_required')
    expect(resultFor(socket, 'd2')?.['error']).toBeUndefined()
  })

  it('shapes a read to the recipe’s payload path and audits what it ran', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    socket.deliver(callFrame('r1', 'shop_list_orders', {}))
    await settle()

    const result = resultFor(socket, 'r1')?.['result'] as { content: { text: string }[] }
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: 200, data: [{ id: 1 }] })

    const audit = (await sendFrom(extensionPage(), { type: 'douze:audit' })) as {
      calls: { tool: string; trust: string; outcome: string }[]
    }
    expect(audit.calls[0]).toMatchObject({ tool: 'shop_list_orders', trust: 'remote', outcome: 'ok' })
  })

  it('masks a credential in a result and never sends it over the wire', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    fake.inject = async (url) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { session: JWT } }),
      url,
      redirected: false,
    })
    socket.deliver(callFrame('r2', 'shop_list_orders', {}))
    await settle()

    // The credential never crosses the socket — the property that matters — but the call now
    // succeeds with the field masked rather than failing and returning nothing.
    expect(JSON.stringify(socket.sent)).not.toContain(JWT)
    expect(JSON.stringify(socket.sent)).toContain('«redacted:')
  })

  it('refuses an argument the recipe never recorded before anything is fetched', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    let fetched = false
    fake.inject = async (url) => {
      fetched = true
      return { status: 200, headers: {}, body: '{}', url, redirected: false }
    }
    socket.deliver(callFrame('a1', 'shop_list_orders', { role: 'admin' }))
    await settle()

    expect(fetched).toBe(false)
    expect(failure(socket, 'a1').code).toBe('invalid_arguments')
    expect(failure(socket, 'a1').message).toContain('"role" is not a parameter of this tool')
  })

  it('stops serving writes on the call after the opt-in is turned off, not on the next alarm', async () => {
    const socket = await attach({ 'attach:relay': { ...RELAY, allow_writes: true } }, 'relay.test')
    await approveShop()
    socket.deliver(callFrame('w1', 'shop_create_order', { item: 'lamp' }))
    await settle()
    expect(resultFor(socket, 'w1')?.['error']).toBeUndefined()

    // `allowWrites` is frozen into the attachment at construction, so nothing about this socket
    // can be re-read: turning the opt-in off has to close it, and no alarm is fired here.
    await sendFrom(extensionPage(), { type: 'douze:connect:writes', allow: false })
    await settle()
    expect(socket.readyState).toBe(3)

    const reopened = dialled('relay.test') as FakeSocket
    expect(reopened).not.toBe(socket)
    reopened.accept()
    await settle()
    reopened.deliver({ type: 'welcome', heartbeat_ms: 20_000 })
    await settle()
    expect(pushedNames(reopened).at(-1)).toEqual(['shop_list_orders'])

    reopened.deliver(callFrame('w2', 'shop_create_order', { item: 'lamp' }))
    await settle()
    expect(failure(reopened, 'w2').code).toBe('trust_refused')
  })

  it('drops an exemption when its tool leaves the surface, so a later namesake does not inherit it', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    fake.inject = async (url) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { session: JWT } }),
      url,
      redirected: false,
    })
    await sendFrom(extensionPage(), {
      type: 'douze:connect:expose',
      trust: 'remote',
      tool: 'shop_list_orders',
      allow: true,
    })
    await settle()
    socket.deliver(callFrame('e1', 'shop_list_orders', {}))
    await settle()
    expect(resultFor(socket, 'e1')?.['error']).toBeUndefined()

    // The recipe goes, and a different `shop` arrives later carrying the same qualified name. The
    // exemption was granted to a tool that no longer exists and must not follow the name.
    const recipes = await RecipeStore.open()
    await recipes.delete('shop')
    await settle()
    expect(fake.local.get('attach:expose')).toEqual({ local: [], remote: [] })

    await approveShop()
    const live = dialled('relay.test') as FakeSocket
    if (live !== socket) {
      live.accept()
      await settle()
      live.deliver({ type: 'welcome', heartbeat_ms: 20_000 })
      await settle()
    }
    live.deliver(callFrame('e2', 'shop_list_orders', {}))
    await settle()
    // The namesake is gated again: its own result crosses with the credential masked, where the
    // exempted tool's crossed with the credential intact.
    const answer = JSON.stringify(resultFor(live, 'e2'))
    expect(answer).not.toContain(JWT)
    expect(answer).toContain('«redacted:')
  })

  it('exempts a tool from the gate at one trust level only', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    fake.inject = async (url) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { session: JWT } }),
      url,
      redirected: false,
    })
    const expose = (trust: string): Promise<unknown> =>
      sendFrom(extensionPage(), { type: 'douze:connect:expose', trust, tool: 'shop_list_orders', allow: true })

    // Exempting it for an app on this computer must not start sending the token to a relay too.
    await expose('local')
    await settle()
    socket.deliver(callFrame('g1', 'shop_list_orders', {}))
    await settle()
    // Still masked on the remote pipe: the local exemption bought it nothing here.
    expect(JSON.stringify(socket.sent)).not.toContain(JWT)

    await expose('remote')
    await settle()
    socket.deliver(callFrame('g2', 'shop_list_orders', {}))
    await settle()
    expect(resultFor(socket, 'g2')?.['error']).toBeUndefined()
  })
})

describe('a call in flight when the socket drops (T-015.8)', () => {
  it('is not answered after the reconnect, because the host already failed it', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()

    let release: (() => void) | undefined
    fake.inject = async (url) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { status: 200, headers: {}, body: '{}', url, redirected: false }
    }
    socket.deliver(callFrame('slow', 'shop_list_orders', {}))
    await settle()

    socket.drop()
    fake.onAlarm.emit({ name: 'douze-attach' })
    await settle()
    const second = dialled('relay.test') as FakeSocket
    second.accept()
    await settle()
    second.deliver({ type: 'welcome', heartbeat_ms: 20_000 })
    await settle()

    release?.()
    await settle()
    // A tool can be a write; the host failed this id at the drop and never re-sends it, so an
    // answer arriving now would settle nothing and could collide with a freshly minted id.
    expect(resultFor(socket, 'slow')).toBeUndefined()
    expect(resultFor(second, 'slow')).toBeUndefined()
  })
})

/**
 * WO-016 — a hosted assistant's write was approved once, at review time, and could then be made
 * silently and forever: the only notification a call could produce was `session_expired`, and the
 * audit ring is seen by whoever opens a page. Not a per-call prompt — that is the control users
 * switch off — but a signal that arrives while the loop is still running.
 */
describe('a change made by a hosted assistant (WO-016)', () => {
  const WRITES = { 'attach:relay': { ...RELAY, allow_writes: true } }

  it('notifies on a write it ran, collapses a burst of them, and stays quiet for reads', async () => {
    const socket = await attach(WRITES, 'relay.test')
    await approveShop()
    const quiet = fake.notifications.length

    socket.deliver(callFrame('w1', 'shop_create_order', { item: 'lamp' }))
    await settle()
    expect(resultFor(socket, 'w1')?.['error']).toBeUndefined()
    expect(fake.notifications).toHaveLength(quiet + 1)
    expect(fake.notifications.at(-1)?.message).toContain('shop_create_order')
    expect(fake.notifications.at(-1)?.message).toContain('app.test')

    // A loop is one notice a minute, not one per call: the rest are counted for the next one.
    for (const id of ['w2', 'w3', 'w4']) socket.deliver(callFrame(id, 'shop_create_order', { item: 'lamp' }))
    await settle()
    expect(fake.notifications).toHaveLength(quiet + 1)

    // Reading is what a hosted assistant does all day and is not what this exists for.
    socket.deliver(callFrame('r1', 'shop_list_orders', {}))
    await settle()
    expect(resultFor(socket, 'r1')?.['error']).toBeUndefined()
    expect(fake.notifications).toHaveLength(quiet + 1)
  })

  it('says nothing about a write it refused, so a lying host cannot fill the notification centre', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    const quiet = fake.notifications.length

    socket.deliver(callFrame('w1', 'shop_create_order', { item: 'lamp' }))
    await settle()
    expect(failure(socket, 'w1').code).toBe('trust_refused')
    expect(fake.notifications).toHaveLength(quiet)
  })
})

/**
 * WO-016 — two reconnection behaviours that had no test at all: a dial that never attached must
 * wait out its backoff, and a socket that has gone silent must be closed rather than left OPEN.
 */
describe('staying reachable across a bad host (T-015.8)', () => {
  const relaySockets = (): FakeSocket[] => FakeSocket.opened.filter((socket) => socket.url.includes('relay.test'))

  it('waits out its backoff before re-dialling a host that never attached', async () => {
    // Only `Date` is faked, so `settle()` and every other real timer still run normally; the
    // backoff is a `Date.now()` comparison, which is exactly what has to move.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await bootWorker({ 'attach:relay': RELAY })
      expect(relaySockets()).toHaveLength(1)
      // Never accepted, so this is a dial that failed rather than a host that dropped.
      relaySockets()[0]?.drop()
      await settle()

      fake.onAlarm.emit({ name: 'douze-attach' })
      await settle()
      // The alarm fires every 30 s whatever happens; without the backoff this is a dial every tick
      // at a host that is refusing the connection.
      expect(relaySockets()).toHaveLength(1)

      vi.setSystemTime(Date.now() + 31_000)
      fake.onAlarm.emit({ name: 'douze-attach' })
      await settle()
      expect(relaySockets()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * A host that goes away without a FIN leaves the socket OPEN, `connect()` reads OPEN as healthy,
   * and the extension is unreachable until Chrome evicts the worker — which is the state the
   * watchdog exists to prevent and nothing tested. Driven with a 20 ms heartbeat rather than fake
   * timers, so the real `setTimeout` in a real booted worker is what fires.
   */
  it('closes a socket that has gone silent, and dials a fresh one on the next alarm', async () => {
    await bootWorker({ 'attach:relay': RELAY })
    const socket = dialled('relay.test') as FakeSocket
    socket.accept()
    await settle()
    socket.deliver({ type: 'welcome', heartbeat_ms: 20 })
    await settle()
    expect(socket.readyState).toBe(1)

    // 2.5 heartbeats of nothing at all — no ping, no pong, no close.
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(socket.readyState).toBe(3)

    fake.onAlarm.emit({ name: 'douze-attach' })
    await settle()
    expect(relaySockets().at(-1)).not.toBe(socket)
  })
})

describe('a host that refuses the pairing (T-015.8/12)', () => {
  /**
   * A 1008 from a bridge port is the word of a peer that has proved nothing — binding one of
   * 8912–8916 takes no privilege — so it stops that port and touches nothing else. It used to
   * overwrite the stored pairing with `{ blocked: true }`, which handed any local process a
   * one-frame way to unpair the user's real bridge and stop all five ports for good; a paired
   * bridge prints no new code, so there was no way back.
   */
  it('stops dialling the port that said 1008, and leaves the pairing it cannot vouch for alone', async () => {
    const socket = await attach({ 'attach:bridge': { secret: 'stale' } }, '127.0.0.1')
    const port = new URL(socket.url).port
    socket.drop(1008)
    await settle()

    expect(fake.notifications.at(-1)?.title).toContain('could not pair')
    // Storage is for the user and for peers that proved themselves. This peer is neither.
    expect(fake.local.get('attach:bridge')).toEqual({ secret: 'stale' })

    fake.onAlarm.emit({ name: 'douze-attach' })
    await settle()
    // That port is done for this worker's life; the other four are still swept, because a squatter
    // on one must not be able to silence the range a real bridge might be listening on.
    const dialledAgain = FakeSocket.opened.filter((opened) => opened.url.includes('127.0.0.1'))
    expect(dialledAgain.filter((opened) => new URL(opened.url).port === port)).toHaveLength(1)
    expect(dialledAgain.length).toBeGreaterThan(1)
  })

  it('stops re-dialling a relay that rejected its token, and says the link needs remaking', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    const before = FakeSocket.opened.length
    socket.drop(1008)
    await settle()

    // Judged on the next tick, not at the close: a rotate the user just performed closes the old
    // socket exactly like this, and the two are only distinguishable once storage has settled.
    expect(fake.notifications.at(-1)?.title).not.toBe('Douze lost its link')
    fake.onAlarm.emit({ name: 'douze-attach' })
    await settle()
    expect(fake.notifications.at(-1)?.title).toBe('Douze lost its link')
    expect(FakeSocket.opened.length).toBe(before)

    // The notification is a toast the user may never see, so the state has to reach the page too:
    // `connected: false` alone reads as "idle, it keeps trying", which is what the connect page
    // used to say about a link that was dead and a socket nothing was retrying.
    expect(await sendFrom(extensionPage(), { type: 'douze:connect:status' })).toMatchObject({
      configured: true,
      stale: true,
    })

    // A token written by the connect page is a different one, so dialling resumes on its own.
    await chrome.storage.local.set({ 'attach:relay': { ...RELAY, token: 'a-new-token' } })
    fake.onAlarm.emit({ name: 'douze-attach' })
    await settle()
    expect(await sendFrom(extensionPage(), { type: 'douze:connect:status' })).toMatchObject({ stale: false })
    const retried = dialled('relay.test') as FakeSocket
    expect(retried).not.toBe(socket)
    retried.accept()
    await settle()
    expect(retried.frames('hello')[0]).toMatchObject({ token: 'a-new-token' })
  })

  /**
   * The relay kills the old token the moment it answers `POST /rotate`, so the extension's socket
   * is closed 1008 by something the user just asked for. Telling them their link died and then
   * silently re-dialling 30 seconds later is how a working feature looks broken.
   */
  it('says nothing when the 1008 was the rotate the user just performed', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    const quiet = fake.notifications.length

    socket.drop(1008)
    await chrome.storage.local.set({ 'attach:relay': { ...RELAY, token: 'rotated-token' } })
    fake.onAlarm.emit({ name: 'douze-attach' })
    await settle()

    expect(fake.notifications).toHaveLength(quiet)
    const retried = dialled('relay.test') as FakeSocket
    expect(retried).not.toBe(socket)
    retried.accept()
    await settle()
    expect(retried.frames('hello')[0]).toMatchObject({ token: 'rotated-token' })
  })

  it('takes a fresh pairing code from the connect page and pins the secret it earns', async () => {
    await attach({ 'attach:bridge': { secret: 'stale' } }, '127.0.0.1')
    ;(dialled('127.0.0.1') as FakeSocket).drop(1008)
    await settle()

    await sendFrom(extensionPage(), { type: 'douze:connect:pair', code: 'four-word-code' })
    await settle()
    const retried = dialled('127.0.0.1') as FakeSocket
    retried.accept()
    await settle()
    await challenge(retried, { code: 'four-word-code' })

    // The bridge mints the credential on a first pairing and hands it back BESIDE `welcome`; the
    // protocol schema strips it, so it is read off the raw frame and pinned for every later dial.
    retried.deliver({ type: 'welcome', heartbeat_ms: 20_000 }, { secret: 'minted-secret' })
    await settle()
    expect(fake.local.get('attach:bridge')).toEqual({ secret: 'minted-secret' })
    // Not even on a FIRST pairing does the code travel: a rogue that owned this port would have
    // learned the code and every credential it buys from that one frame.
    expect(JSON.stringify(retried.sent)).not.toContain('four-word-code')
    expect(JSON.stringify(retried.sent)).not.toContain('minted-secret')
  })
})

/**
 * T-015.12 — **the rogue on the port.** Binding a loopback port is not privileged, so any process
 * running as the user can take one of 8912–8916 and wait for the extension's next 30-second alarm.
 * Everything this describes is a peer that answered the dial without holding the credential, and
 * the assertion is always the same: it is told nothing and can do nothing.
 */
describe('a bridge that cannot prove it holds the credential (T-015.12)', () => {
  const BRIDGE = { 'attach:bridge': { secret: 'pinned-secret' } }
  /** A proof of the right shape and the wrong value, which is all a rogue can produce. */
  const FORGED = 'a'.repeat(64)

  it('is refused local trust, told no surface, and cannot run a destructive tool', async () => {
    await bootWorker(BRIDGE)
    await approveShop()
    const socket = dialled('127.0.0.1') as FakeSocket
    socket.accept()
    await settle()

    // The whole attack in three frames: answer the dial, forge a welcome, ask for the tool that
    // only `local` trust reaches.
    socket.deliver({ type: 'bridge.challenge', nonce: mintNonce(), proof: FORGED })
    socket.deliver({ type: 'welcome', heartbeat_ms: 20_000 }, { secret: 'rogue-secret' })
    socket.deliver(callFrame('x1', 'shop_delete_order', { id: '7', confirm: true }, 'local'))
    await settle()
    await settle()

    expect(socket.frames('bridge.proof')).toEqual([])
    expect(socket.frames('surface.push')).toEqual([])
    expect(socket.frames('tool.result')).toEqual([])
    // And it could not swap the pinned credential for one of its own on the way past.
    expect(fake.local.get('attach:bridge')).toEqual({ secret: 'pinned-secret' })
  })

  it('cannot replay a real bridge’s challenge at the next dial, because the nonces are spent', async () => {
    await bootWorker(BRIDGE)
    const first = dialled('127.0.0.1') as FakeSocket
    first.accept()
    await settle()
    // What a real bridge said on a real attach, recorded off the wire the way a rogue would.
    const recorded = await challenge(first, { secret: 'pinned-secret' })
    first.deliver({ type: 'welcome', heartbeat_ms: 20_000 })
    await settle()
    expect(first.frames('bridge.proof')).toHaveLength(1)

    first.drop()
    fake.onAlarm.emit({ name: 'douze-attach' })
    await settle()
    const second = dialled('127.0.0.1') as FakeSocket
    second.accept()
    await settle()
    second.deliver({ type: 'bridge.challenge', nonce: recorded.nonce, proof: recorded.proof })
    second.deliver({ type: 'welcome', heartbeat_ms: 20_000 })
    await settle()
    await settle()

    expect(second.frames('bridge.proof')).toEqual([])
    expect(second.frames('surface.push')).toEqual([])
  })

  it('answers nothing to a peer that skips the handshake and just says welcome', async () => {
    const socket = await attach(BRIDGE, '127.0.0.1')
    await approveShop()
    socket.deliver({ type: 'ping' })
    socket.deliver(callFrame('x2', 'shop_list_orders', {}, 'local'))
    await settle()

    expect(socket.frames('pong')).toEqual([])
    expect(socket.frames('surface.push')).toEqual([])
    expect(socket.frames('tool.result')).toEqual([])
  })
})

describe('an expired session (AC-EXE-002.3)', () => {
  it('notifies with the site’s name, and clicking it opens the login page', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    fake.inject = async () => ({
      status: 200,
      headers: {},
      body: '',
      url: 'https://app.test/login',
      redirected: true,
    })
    socket.deliver(callFrame('e1', 'shop_list_orders', {}))
    await settle()

    expect(failure(socket, 'e1').code).toBe('session_expired')
    const notification = fake.notifications.at(-1)
    expect(notification?.title).toBe('Signed out of app.test')

    fake.onNotificationClicked.emit(notification?.id)
    await settle()
    expect(fake.created).toContain('https://app.test/login')
  })
})

/**
 * WO-015 T-015.10 — the connect page's commands, which are the whole no-terminal path: someone
 * with no terminal ends up with a URL to paste into ChatGPT, and can take it back again.
 *
 * The relay's HTTP API is faked at `fetch` and nothing below it is, so the pairing that lands in
 * `chrome.storage.local` is the one the attachment client reads on its next alarm.
 */
describe('sharing Douze with a hosted assistant (T-015.10)', () => {
  const connect = (command: Record<string, unknown>): Promise<ConnectState> =>
    sendFrom(extensionPage(), command) as Promise<ConnectState>

  const storedRelay = (): RelayPairing | undefined => fake.local.get('attach:relay') as RelayPairing | undefined

  it('registers with the default relay and hands back the link to paste', async () => {
    const state = await connect({ type: 'douze:connect:start' })

    expect(relayCalls).toEqual([
      { url: 'https://douze.jamalavedra.com/register', method: 'POST', body: { daemon_version: '0.1.0' } },
    ])
    // Exactly what `attach.ts` reads, including the write opt-in, which starts ON: a connector
    // that can only read is not what anyone connects Douze for. Deleting stays impossible.
    expect(storedRelay()).toEqual({
      url: 'https://douze.jamalavedra.com',
      token: 'minted-token',
      mcp_path: '/m/minted',
      allow_writes: true,
    })
    expect(state.error).toBeUndefined()
    expect(state.configured).toBe(true)
    expect(state.mcp_url).toBe('https://douze.jamalavedra.com/m/minted')
    expect(state.allow_writes).toBe(true)
  })

  it('registers with a relay the user runs themselves, trailing slash and all', async () => {
    const state = await connect({ type: 'douze:connect:start', url: 'https://relay.example.com/' })
    expect(relayCalls[0]?.url).toBe('https://relay.example.com/register')
    expect(state.mcp_url).toBe('https://relay.example.com/m/minted')
  })

  it('refuses a relay address that would send the link in the clear, and shares nothing', async () => {
    const state = await connect({ type: 'douze:connect:start', url: 'http://relay.example.com' })
    expect(state.error).toContain('https://')
    expect(relayCalls).toEqual([])
    expect(storedRelay()).toBeUndefined()
    expect(state.configured).toBe(false)
  })

  it('says which permission is missing rather than failing as a network error', async () => {
    fake.hostPermission = false
    const state = await connect({ type: 'douze:connect:start' })
    expect(state.error).toContain('permission')
    expect(state.error).toContain('https://douze.jamalavedra.com')
    expect(relayCalls).toEqual([])
    expect(storedRelay()).toBeUndefined()
  })

  it('reports a relay that is out of registrations in words, not a status code', async () => {
    relayAnswer = () => ({ status: 429 })
    const state = await connect({ type: 'douze:connect:start' })
    expect(state.error).toContain('Try again in an hour.')
    expect(state.error).not.toContain('429')
    expect(storedRelay()).toBeUndefined()
  })

  it('rotates by REPLACING the pairing, so the dead link is not left in storage', async () => {
    await connect({ type: 'douze:connect:start' })
    relayAnswer = () => ({ status: 200, body: { token: 'second-token', mcp_path: '/m/second' } })

    const state = await connect({ type: 'douze:connect:rotate' })
    expect(relayCalls.at(-1)).toEqual({
      url: 'https://douze.jamalavedra.com/rotate',
      method: 'POST',
      token: 'minted-token',
    })
    expect(storedRelay()).toEqual({
      url: 'https://douze.jamalavedra.com',
      token: 'second-token',
      mcp_path: '/m/second',
      allow_writes: true,
    })
    expect(state.mcp_url).toBe('https://douze.jamalavedra.com/m/second')
    // The relay killed the old pair as it answered; nothing here may still be holding it.
    expect(JSON.stringify(fake.local.get('attach:relay'))).not.toContain('minted')
  })

  it('keeps the link when a rotate fails, and says so', async () => {
    await connect({ type: 'douze:connect:start' })
    relayAnswer = () => ({ status: 401 })

    const state = await connect({ type: 'douze:connect:rotate' })
    expect(state.error).toContain('does not recognise this link')
    expect(storedRelay()?.token).toBe('minted-token')
    expect(state.mcp_url).toBe('https://douze.jamalavedra.com/m/minted')
  })

  it('tells the relay to drop the endpoint and clears the pairing', async () => {
    await connect({ type: 'douze:connect:start' })
    relayAnswer = () => ({ status: 204 })

    const state = await connect({ type: 'douze:connect:stop' })
    expect(relayCalls.at(-1)).toEqual({
      url: 'https://douze.jamalavedra.com/register',
      method: 'DELETE',
      token: 'minted-token',
    })
    expect(storedRelay()).toBeUndefined()
    // Nothing is shared, so the page shows what the NEXT link would carry rather than the dead
    // pairing's setting.
    expect(state).toMatchObject({ configured: false, mcp_url: '', allow_writes: true })
    expect(state.error).toBeUndefined()
    expect(state.warning).toBeUndefined()
  })

  it('stops sharing even when the relay cannot be reached, and warns instead of refusing', async () => {
    await connect({ type: 'douze:connect:start' })
    globals['fetch'] = () => Promise.reject(new TypeError('Failed to fetch'))

    const state = await connect({ type: 'douze:connect:stop' })
    // Someone who wants to stop sharing must always be able to: the pairing is gone either way.
    expect(storedRelay()).toBeUndefined()
    expect(state.configured).toBe(false)
    expect(state.error).toBeUndefined()
    expect(state.warning).toContain('could not tell')
    expect(state.warning).toContain('https://douze.jamalavedra.com')
  })

  it('refuses to rotate, stop or change writes when nothing is shared, calling nobody', async () => {
    for (const type of ['douze:connect:rotate', 'douze:connect:stop', 'douze:connect:writes']) {
      const state = await connect({ type, allow: true })
      expect(state.error).toContain('nothing to change')
    }
    expect(relayCalls).toEqual([])
  })

  it('turns the write opt-in on and off on the stored pairing, and tells nobody else', async () => {
    await connect({ type: 'douze:connect:start' })

    const on = await connect({ type: 'douze:connect:writes', allow: true })
    expect(storedRelay()?.allow_writes).toBe(true)
    expect(on.allow_writes).toBe(true)
    // The attachment key carries the opt-in, so the client re-dials on its own; the relay's API
    // has no say in it and must not be called.
    expect(relayCalls).toHaveLength(1)

    const off = await connect({ type: 'douze:connect:writes', allow: false })
    expect(storedRelay()?.allow_writes).toBe(false)
    expect(off.allow_writes).toBe(false)
  })

  it('adds and removes an exemption per trust level, and never across them', async () => {
    await approveShop()
    const exempt = (trust: string, allow: boolean): Promise<ConnectState> =>
      connect({ type: 'douze:connect:expose', trust, tool: 'shop_list_orders', allow })

    const local = await exempt('local', true)
    expect(local.exposed).toEqual({ local: ['shop_list_orders'], remote: [] })

    const both = await exempt('remote', true)
    expect(both.exposed).toEqual({ local: ['shop_list_orders'], remote: ['shop_list_orders'] })

    const removed = await exempt('remote', false)
    expect(removed.exposed).toEqual({ local: ['shop_list_orders'], remote: [] })
    expect(fake.local.get('attach:expose')).toEqual({ local: ['shop_list_orders'], remote: [] })
  })

  it('tells the page what there is to be told, and nothing it cannot know', async () => {
    await approveShop()
    expect(await connect({ type: 'douze:connect:status' })).toEqual({
      configured: false,
      // Named before anything is shared, so the setup screen says where the link would come from.
      url: 'https://douze.jamalavedra.com',
      mcp_url: '',
      // Nothing is shared yet, and this is what a link would be minted with.
      allow_writes: true,
      connected: false,
      tools: ['shop_list_orders', 'shop_create_order', 'shop_delete_order'],
      exposed: { local: [], remote: [] },
      bridge: 'unpaired',
      // Nothing is shared, so there is no link for the relay to have forgotten.
      stale: false,
    })
  })

  it('reports the bridge as it actually is at each step of pairing', async () => {
    expect((await connect({ type: 'douze:connect:status' })).bridge).toBe('unpaired')

    // The code is in storage and no host has accepted it yet — which is neither paired nor not.
    await connect({ type: 'douze:connect:pair', code: 'four-word-code' })
    expect((await connect({ type: 'douze:connect:status' })).bridge).toBe('trying')

    const socket = dialled('127.0.0.1') as FakeSocket
    socket.accept()
    await settle()
    // Still `trying` until the far side proves it holds the code: a welcome alone is something any
    // process that took the port can say.
    await challenge(socket, { code: 'four-word-code' })
    socket.deliver({ type: 'welcome', heartbeat_ms: 20_000 }, { secret: 'minted-secret' })
    await settle()
    expect((await connect({ type: 'douze:connect:status' })).bridge).toBe('paired')

    socket.drop(1008)
    await settle()
    expect((await connect({ type: 'douze:connect:status' })).bridge).toBe('refused')
  })

  /**
   * The other half of pairing, which did not exist: an app paired once held `local` trust — every
   * write and every destructive tool — for the life of the install, and the page that granted it
   * had no way to take it back.
   */
  it('withdraws a pairing, forgets the secret, and drops the socket that had it', async () => {
    const socket = await attach({ 'attach:bridge': { secret: 'pinned-secret' } }, '127.0.0.1', {
      secret: 'pinned-secret',
    })
    await approveShop()
    expect((await connect({ type: 'douze:connect:status' })).bridge).toBe('paired')

    const state = await connect({ type: 'douze:connect:unpair' })
    expect(state.bridge).toBe('unpaired')
    // Forgotten, not merely disconnected: re-pairing means typing the code the app prints again.
    expect(fake.local.get('attach:bridge')).toBeUndefined()
    // Closed here rather than left to the next alarm: a bridge just unpaired must not go on
    // running destructive tools for the 30 seconds until then.
    expect(socket.readyState).toBe(3)
  })
})

/**
 * WO-015 review round — the three ported features that reached nothing. `importHar`,
 * `RecipeStore.exportAll`/`importFiles` and `CaptureStore.deleteSession` were implemented and
 * unit-tested with no caller anywhere outside their own tests: the CLI that used to reach them was
 * deleted and nothing replaced it. These drive the routes the data page uses.
 */
describe('what Douze has stored, from the data page', () => {
  const data = async (message: Record<string, unknown>): Promise<DataState> =>
    (await sendFrom(extensionPage(), message)) as DataState

  const record = async (name: string): Promise<string> => {
    const id = await douze().startSession(name, ['https://app.test'], { tabId: 7 })
    await capture(exchangeEvents(`${name}-1`, 'GET', 'https://app.test/api/orders'))
    await capture(exchangeEvents(`${name}-2`, 'POST', 'https://app.test/api/orders'))
    await douze().stopSession()
    return id
  }

  /** One JSON entry of a HAR, with the content type a test wants on it. */
  const harEntry = (url: string, mimeType = 'application/json'): unknown => ({
    startedDateTime: '2026-08-05T10:00:00.000Z',
    time: 10,
    request: { method: 'GET', url, headers: [] },
    response: {
      status: 200,
      headers: [{ name: 'content-type', value: 'application/json' }],
      content: { mimeType, size: 10, text: JSON.stringify({ ok: true }) },
    },
  })

  it('lists every recording with what it retained', async () => {
    const first = await record('Orders')
    const second = await record('Invoices')

    const state = await data({ type: 'douze:data:list' })
    // As a map, not a list: both sessions can start inside the same millisecond, and the order
    // `sessions()` sorts by is `started_at` — asserting it here would be asserting the clock.
    expect(new Map(state.sessions.map((session) => [session.id, [session.name, session.exchange_count]]))).toEqual(
      new Map([
        [first, ['Orders', 2]],
        [second, ['Invoices', 2]],
      ]),
    )
  })

  /**
   * The privacy half of this: a recording of a signed-in dashboard sat in IndexedDB under
   * `unlimitedStorage` with nothing anywhere that could remove it.
   */
  it('deletes a recording and everything under it, leaving the others alone', async () => {
    const doomed = await record('Orders')
    const kept = await record('Invoices')

    const state = await data({ type: 'douze:data:delete', sessionId: doomed })
    expect(state.sessions.map((session) => session.id)).toEqual([kept])

    const captures = await openCaptures()
    expect(await captures.session(doomed)).toBeNull()
    expect(await captures.countExchanges(doomed)).toBe(0)
    expect((await captures.session(kept))?.exchanges).toHaveLength(2)
  })

  it('imports a .har as a recording and reports what the write gate refused, one by one', async () => {
    const state = await data({
      type: 'douze:data:import-har',
      name: 'From a file',
      har: {
        log: {
          entries: [
            harEntry('https://app.test/api/a'),
            // The token rides in the content type, which redaction does not walk — so the store's
            // gate refuses this one entry and the import keeps the rest.
            harEntry('https://app.test/api/token', `application/json;profile=${JWT}`),
            harEntry('https://app.test/api/b'),
            harEntry('https://www.google-analytics.com/collect'),
          ],
        },
      },
    })

    expect(state.har?.imported).toBe(2)
    expect(state.har?.skipped).toBe(1)
    expect(state.har?.refused.map((entry) => entry.url)).toEqual(['https://app.test/api/token'])
    expect(state.har?.refused[0]?.reason).toMatch(/credential at/)
    // The refusal is a report, not a lost import: the session is listed with what it did keep.
    expect(state.sessions.map((session) => [session.name, session.exchange_count])).toEqual([['From a file', 2]])
    expect(JSON.stringify(state)).not.toContain(JWT)
  })

  it('exports every recipe with its fixtures, and takes the same files back', async () => {
    await approveShop()

    const exported = await data({ type: 'douze:data:export' })
    const files = exported.files ?? []
    expect(files.map((file) => file.path)).toEqual([
      'recipes/shop.yaml',
      'fixtures/shop/create_order.json',
      'fixtures/shop/delete_order.json',
      'fixtures/shop/list_orders.json',
    ])
    expect(exported.recipes).toEqual([{ name: 'shop', tools: 3 }])

    // A second browser: the same files, imported into a worker that has never seen them.
    await bootWorker()
    const imported = await data({ type: 'douze:data:import', files })
    expect(imported.imported?.ok).toBe(true)
    expect(imported.imported?.imported).toEqual(['shop'])
    expect(imported.imported?.fixtures).toEqual([
      'shop/create_order.json',
      'shop/delete_order.json',
      'shop/list_orders.json',
    ])

    /**
     * WO-016 #1 — every file crossed, and nothing is turned on. `approved` used to come out of the
     * file, which made sending someone a .yaml the one way to put tools on their surface with no
     * review page, no tick boxes and no moment where a human read what they do. `dataState` counts
     * APPROVED tools, so this zero is the consent model holding — assert the approval itself as
     * well, or a future zero for some unrelated reason would look like this test still passing.
     */
    expect(imported.recipes).toEqual([{ name: 'shop', tools: 0 }])
    const stored = (await RecipeStore.open()).recipe('shop')
    expect(stored?.tools.map((tool) => tool.name).sort()).toEqual(['create_order', 'delete_order', 'list_orders'])
    expect(stored?.tools.map((tool) => tool.approved)).toEqual([false, false, false])
    // Not merely filtered on the way out: what is stored says what is true.
    expect(String(fake.local.get('recipe:shop'))).not.toContain('approved: true')
    // The example answers still crossed, so a review of the import has its evidence to show.
    expect(fake.local.get('fixture:shop/list_orders.json')).toBeDefined()
  })

  it('refuses an import that would overwrite a skill until it is told to, by name', async () => {
    await approveShop()
    const files = (await data({ type: 'douze:data:export' })).files ?? []

    const refused = await data({ type: 'douze:data:import', files })
    expect(refused.imported?.ok).toBe(false)
    expect(refused.imported?.conflicts).toEqual(['shop'])
    // AC-REC-003 — nothing is written unless the whole set validates and no name collides.
    expect(refused.imported?.imported).toEqual([])

    const taken = await data({ type: 'douze:data:import', files, overwrite: true })
    expect(taken.imported?.ok).toBe(true)
    expect(taken.imported?.imported).toEqual(['shop'])
  })

  it('answers with the reason and changes nothing when the file holds no entries', async () => {
    const state = await data({ type: 'douze:data:import-har', name: 'Nonsense', har: { log: { entries: [] } } })
    expect(state.error).toMatch(/no entries/i)
    expect(state.sessions).toEqual([])
  })

  /**
   * `RecipeStore.delete` had zero callers. A skill set built from a site the user no longer uses
   * stayed on the surface — and so on every attached assistant — until the extension was removed.
   */
  it('deletes a recipe, its fixtures, and the tools it put on the surface', async () => {
    await approveShop()
    expect((await data({ type: 'douze:data:list' })).recipes).toEqual([{ name: 'shop', tools: 3 }])

    const state = await data({ type: 'douze:data:delete-recipe', name: 'shop' })
    expect(state.recipes).toEqual([])
    // Not merely hidden: the YAML and every example answer are out of storage.
    expect([...fake.local.keys()].filter((key) => key.startsWith('recipe:') || key.startsWith('fixture:'))).toEqual(
      [],
    )
    const recipes = await RecipeStore.open()
    expect(recipes.surface().tools).toEqual([])
  })

  /**
   * AC-EXE-003.3 — the audit is a record of what somebody's assistant did in their accounts, kept
   * in `chrome.storage.local` for the life of the install. Nothing could read it back on a page
   * and nothing at all could remove it.
   */
  it('lists what assistants have run and clears it when asked', async () => {
    const socket = await attach({ 'attach:relay': RELAY }, 'relay.test')
    await approveShop()
    socket.deliver(callFrame('a1', 'shop_list_orders', {}))
    await settle()

    const listed = await data({ type: 'douze:data:list' })
    expect(listed.calls).toMatchObject([{ tool: 'shop_list_orders', trust: 'remote', outcome: 'ok' }])
    // No arguments and no result: what the page shows is what the log deliberately holds.
    expect(Object.keys(listed.calls[0] ?? {}).sort()).toEqual(['at', 'duration_ms', 'outcome', 'status', 'tool', 'trust'])

    const cleared = await data({ type: 'douze:data:clear-audit' })
    expect(cleared.calls).toEqual([])
    expect(fake.local.get('attach:audit')).toBeUndefined()
  })
})

/**
 * A review opened while the site is still being recorded was inferred from the exchanges that had
 * landed by then. The session was cached by id alone, so it stayed that way for the rest of the
 * recording — the daemon rebuilt on a count change, and so does this.
 */
describe('a review opened while the recording is still running', () => {
  it('rebuilds when the capture has grown, and reuses the session when it has not', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    for (const n of [1, 2, 3]) await capture(exchangeEvents(`r${n}`, 'GET', 'https://app.test/api/orders'))
    await settle()

    const load = async (): Promise<ReviewState> =>
      (await sendFrom(extensionPage(), { type: 'douze:review:load', sessionId: id })) as ReviewState
    expect((await load()).candidates.map((candidate) => candidate.name)).toEqual(['list_orders'])

    for (const n of [1, 2, 3]) await capture(exchangeEvents(`w${n}`, 'POST', 'https://app.test/api/orders'))
    await settle()
    expect((await load()).candidates.map((candidate) => candidate.name).sort()).toEqual([
      'create_order',
      'list_orders',
    ])

    // Nothing new captured: the same session is handed back, so an approval made on the page is
    // still there when the page asks again.
    await sendFrom(extensionPage(), { type: 'douze:review:enable', sessionId: id, names: ['list_orders'] })
    const again = await load()
    expect(again.candidates.find((candidate) => candidate.name === 'list_orders')?.approved).toBe(true)

    // And a capture landing between the page's own `enable` and its `save` does not take the
    // approval with it: only `load` re-infers, because only `load` redraws the list.
    await capture(exchangeEvents('r4', 'GET', 'https://app.test/api/orders'))
    await settle()
    const saved = (await sendFrom(extensionPage(), { type: 'douze:review:save', sessionId: id })) as {
      tools?: string[]
      error?: string
    }
    expect(saved.error).toBeUndefined()
    expect(saved.tools).toEqual(['list_orders'])
  })
})

/**
 * WO-016 — the review page's order is correct-then-keep: the name, the description and now the
 * consequence are all edited before the first tick box is sent. Every one of those came back as an
 * error, because the worker saved after every edit and `save()` refuses to write a recipe with
 * nothing approved in it. The page's only handling for a failed edit is to put the old value back,
 * so a correction made at the moment the reader spotted the mistake was reverted in front of them.
 */
describe('a correction made before anything has been ticked (WO-016)', () => {
  it('is accepted, kept, and written by the save that follows it', async () => {
    const id = await douze().startSession('Shop', ['https://app.test'], { tabId: 7 })
    for (const n of [1, 2, 3]) await capture(exchangeEvents(`w${n}`, 'POST', 'https://app.test/api/orders'))
    await settle()

    const edit = (await sendFrom(extensionPage(), {
      type: 'douze:review:edit',
      sessionId: id,
      name: 'create_order',
      field: 'side_effect',
      value: 'destructive',
    })) as { ok?: true; error?: string }
    expect(edit.error).toBeUndefined()
    // Nothing was written — there was nothing approved to write — and nothing was lost either.
    expect(fake.local.get('recipe:shop')).toBeUndefined()

    const state = (await sendFrom(extensionPage(), { type: 'douze:review:load', sessionId: id })) as ReviewState
    expect(state.candidates.find((c) => c.name === 'create_order')?.side_effect).toBe('destructive')

    await sendFrom(extensionPage(), { type: 'douze:review:enable', sessionId: id, names: ['create_order'] })
    const saved = (await sendFrom(extensionPage(), { type: 'douze:review:save', sessionId: id })) as {
      tools?: string[]
      error?: string
    }
    expect(saved.error).toBeUndefined()
    expect(saved.tools).toEqual(['create_order'])
  })
})

