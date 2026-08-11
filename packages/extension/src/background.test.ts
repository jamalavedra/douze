import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Recipe } from '@douze/shared'
import type { PageEvent } from './messages.js'
import { RecipeStore } from './recipes.js'
import { ReviewSession } from './review-session.js'
import { CaptureStore } from './store.js'

/**
 * WO-015 T-015.1 — the service worker recorded into its own store, driven the way Chrome drives
 * it: through the message listener it registers at the top level.
 *
 * No jsdom and no browser, as everywhere else in this package: `chrome.*` and `indexedDB` are
 * installed on `globalThis` for the duration of a test. The IndexedDB fake is `store.test.ts`'s,
 * because the point here is that a real `CaptureStore` is written and read back — the fake covers
 * exactly what `store.ts` uses (compound indexes, bound ranges, a backwards key cursor) and
 * proves nothing about a real browser's transaction lifetimes or quota.
 *
 * `vi.resetModules()` before each import is what makes the worker fresh: the module registers its
 * listeners and starts its `hydrated` promise at import time, exactly as Chrome respawning it does.
 */

// --- IndexedDB fake (see store.test.ts) ------------------------------------

type Rec = Record<string, unknown>
type Key = string | number | Array<string | number>

const rank = (value: Key): number => (Array.isArray(value) ? 3 : typeof value === 'string' ? 2 : 1)

function compare(a: Key, b: Key): number {
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      const part = compare(a[i] as Key, b[i] as Key)
      if (part !== 0) return part
    }
    return a.length - b.length
  }
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0
}

class FakeKeyRange {
  constructor(
    readonly lower: Key,
    readonly upper: Key,
  ) {}

  static bound(lower: Key, upper: Key): FakeKeyRange {
    return new FakeKeyRange(lower, upper)
  }

  includes(key: Key): boolean {
    return compare(key, this.lower) >= 0 && compare(key, this.upper) <= 0
  }
}

interface FakeStoreData {
  keyPath: string
  records: Map<string, Rec>
  indexes: Map<string, string[]>
}

interface FakeDbData {
  version: number
  stores: Map<string, FakeStoreData>
}

interface FakeRequest<T> {
  result: T
  error: null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onupgradeneeded?: ((event: { oldVersion: number }) => void) | null
}

const databases = new Map<string, FakeDbData>()

function respond<T>(result: T): FakeRequest<T> {
  const request: FakeRequest<T> = { result, error: null, onsuccess: null, onerror: null }
  queueMicrotask(() => request.onsuccess?.())
  return request
}

function entriesOf(data: FakeStoreData, keyPath: string[], range: FakeKeyRange) {
  const entries: Array<{ key: Key; primary: string; value: Rec }> = []
  for (const [primary, value] of data.records) {
    const key = keyPath.map((part) => value[part] as string | number)
    if (range.includes(key)) entries.push({ key, primary, value })
  }
  return entries.sort((a, b) => compare(a.key, b.key) || compare(a.primary, b.primary))
}

function indexFacade(data: FakeStoreData, keyPath: string[]) {
  return {
    getAll: (range: FakeKeyRange) => respond(entriesOf(data, keyPath, range).map((entry) => entry.value)),
    getAllKeys: (range: FakeKeyRange) => respond(entriesOf(data, keyPath, range).map((entry) => entry.primary)),
    openKeyCursor: (range: FakeKeyRange, direction: string) => {
      const entries = entriesOf(data, keyPath, range)
      const chosen = direction === 'prev' ? entries.at(-1) : entries[0]
      return respond(chosen ? { key: chosen.key, primaryKey: chosen.primary } : null)
    },
  }
}

function storeFacade(data: FakeStoreData) {
  return {
    put: (value: Rec) => {
      data.records.set(String(value[data.keyPath]), structuredClone(value))
      return respond(undefined)
    },
    get: (key: string) => respond(data.records.get(key)),
    delete: (key: string) => {
      data.records.delete(key)
      return respond(undefined)
    },
    getAll: () => respond([...data.records.values()]),
    index: (name: string) => {
      const keyPath = data.indexes.get(name)
      if (!keyPath) throw new Error(`no such index: ${name}`)
      return indexFacade(data, keyPath)
    },
  }
}

function dbFacade(data: FakeDbData) {
  const store = (name: string): FakeStoreData => {
    const found = data.stores.get(name)
    if (!found) throw new Error(`no such object store: ${name}`)
    return found
  }
  return {
    createObjectStore: (name: string, options: { keyPath: string }) => {
      const created: FakeStoreData = { keyPath: options.keyPath, records: new Map(), indexes: new Map() }
      data.stores.set(name, created)
      return {
        createIndex: (indexName: string, keyPath: string[]) => {
          created.indexes.set(indexName, keyPath)
        },
      }
    },
    transaction: () => ({ objectStore: (name: string) => storeFacade(store(name)) }),
    close: () => undefined,
  }
}

const fakeIndexedDB = {
  open: (name: string, version: number) => {
    const data = databases.get(name) ?? { version: 0, stores: new Map() }
    databases.set(name, data)
    const request: FakeRequest<ReturnType<typeof dbFacade>> = {
      result: dbFacade(data),
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    }
    queueMicrotask(() => {
      if (version > data.version) {
        const oldVersion = data.version
        data.version = version
        request.onupgradeneeded?.({ oldVersion })
      }
      request.onsuccess?.()
    })
    return request
  },
}

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
  remove: async (keys: string | string[]): Promise<void> => {
    for (const key of typeof keys === 'string' ? [keys] : keys) items.delete(key)
  },
})

interface FakeChrome {
  onMessage: FakeEvent
  reloaded: number[]
  created: string[]
  badge: string
  registered: string[]
  local: Map<string, unknown>
}

const globals = globalThis as Record<string, unknown>

function installChrome(): FakeChrome {
  const onMessage = fakeEvent()
  const onChanged = fakeEvent()
  const local = new Map<string, unknown>()
  const session = new Map<string, unknown>()
  const state: FakeChrome = { onMessage, reloaded: [], created: [], badge: '', registered: [], local }

  globals['chrome'] = {
    runtime: {
      onMessage,
      onInstalled: fakeEvent(),
      getURL: (path: string) => `chrome-extension://douze/${path}`,
      getManifest: () => ({ version: '0.1.0' }),
    },
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
      registerContentScripts: async (scripts: Array<{ id: string }>) => {
        state.registered = scripts.map((script) => script.id)
      },
      unregisterContentScripts: async () => undefined,
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

async function bootWorker(): Promise<void> {
  databases.clear()
  fake = installChrome()
  globals['indexedDB'] = fakeIndexedDB
  globals['IDBKeyRange'] = FakeKeyRange
  vi.resetModules()
  await import('./background.js')
  await settle()
}

const capture = async (events: PageEvent[], origin = 'https://app.test'): Promise<void> => {
  await sendFrom(contentScript(origin), { type: 'douze:capture', batch: events })
}

const openCaptures = (): Promise<CaptureStore> => CaptureStore.open()

beforeEach(bootWorker)

afterEach(() => {
  delete globals['chrome']
  delete globals['indexedDB']
  delete globals['IDBKeyRange']
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
    expect(await sendFrom(forged, { type: 'douze:start', name: 'x', origins: ['https://evil.test'], useDebugger: false })).toBeUndefined()
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

