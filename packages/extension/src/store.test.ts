import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Exchange, findSurvivingSecrets } from '@douze/shared'
import { CaptureStore } from './store.js'

/**
 * The extension's vitest runs on plain Node with no jsdom, so browser globals are installed on
 * `globalThis` for the duration of a test — the same thing `relay.test.ts` does for `chrome.*`.
 * No IndexedDB implementation is available in this workspace and none is worth adding for one
 * module, so what follows is an in-memory fake covering exactly the surface `store.ts` uses:
 * object stores keyed by `id`, compound indexes, bound key ranges, `getAll`/`getAllKeys`, a
 * backwards key cursor, and a versioned open with `oldVersion`.
 *
 * It therefore exercises THIS module's logic — index choice, ranges, ordering, the write gate —
 * and proves nothing about a real browser's IndexedDB: transaction lifetimes, auto-commit,
 * structured-clone limits and quota behaviour are out of its reach.
 */

type Rec = Record<string, unknown>
type Key = string | number | Array<string | number>

/** IndexedDB key ordering, cut down to what this module stores: number < string < array. */
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
let upgrades = 0

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
        upgrades += 1
        request.onupgradeneeded?.({ oldVersion })
      }
      request.onsuccess?.()
    })
    return request
  },
}

const globals = globalThis as Record<string, unknown>

const exchange = (sessionId: string, position: number, extra: Partial<Exchange> = {}): Exchange => ({
  // Unique across sessions, as the pipeline's UUIDs are — `id` is the primary key. Kept short:
  // a 40-character random-looking id is credential-shaped to the gate, and a UUID (36) is not.
  id: `${sessionId.slice(0, 4)}-e${position}`,
  session_id: sessionId,
  position,
  started_at: 1_700_000_000_000 + position,
  duration_ms: 5,
  method: 'GET',
  url: 'https://app.test/api/orders',
  origin: 'https://app.test',
  request_headers: {},
  status: 200,
  response_headers: {},
  body_missing: false,
  background: false,
  source: 'main_world',
  credentials: [],
  ...extra,
})

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'

describe('extension capture store (T-015.1)', () => {
  let name = ''
  let counter = 0

  beforeEach(() => {
    databases.clear()
    upgrades = 0
    counter += 1
    name = `douze-test-${counter}`
    globals['indexedDB'] = fakeIndexedDB
    globals['IDBKeyRange'] = FakeKeyRange
  })

  afterEach(() => {
    delete globals['indexedDB']
    delete globals['IDBKeyRange']
  })

  const open = (): Promise<CaptureStore> => CaptureStore.open(name)

  it('creates its schema on an empty database and reuses it on reopen', async () => {
    const store = await open()
    const session = await store.startSession({ name: 'Shop orders', origins: ['https://app.test'] })
    await store.appendExchange(exchange(session.id, 0))
    store.close()
    expect(upgrades).toBe(1)

    const reopened = await open()
    // Same version — the upgrade branch must not run again, and nothing may be recreated.
    expect(upgrades).toBe(1)
    const detail = await reopened.session(session.id)
    expect(detail?.session.name).toBe('Shop orders')
    expect(detail?.exchanges).toHaveLength(1)
  })

  it('reads exchanges back in position order however they were appended', async () => {
    const store = await open()
    const session = await store.startSession({ name: 's', origins: ['https://app.test'] })
    const shuffled = [7, 0, 23, 4, 15, 1, 9, 2, 20, 3, 18, 5, 11, 6, 22, 8, 19, 10, 21, 12, 17, 13, 16, 14, 24]
    for (const position of shuffled) await store.appendExchange(exchange(session.id, position))

    const detail = await store.session(session.id)
    expect(detail?.exchanges.map((e) => e.position)).toEqual(Array.from({ length: 25 }, (_, i) => i))
    expect(await store.countExchanges(session.id)).toBe(25)
  })

  it('lists sessions with the number of exchanges each retained', async () => {
    const store = await open()
    const busy = await store.startSession({ id: 'busy', name: 'Busy', origins: ['https://app.test'] })
    const quiet = await store.startSession({ id: 'quiet', name: 'Quiet', origins: ['https://app.test'] })
    for (const position of [0, 1, 2]) await store.appendExchange(exchange(busy.id, position))
    await store.appendExchange(exchange(quiet.id, 0))

    const listed = await store.sessions()
    expect(new Map(listed.map((s) => [s.id, s.exchange_count]))).toEqual(new Map([
      ['busy', 3],
      ['quiet', 1],
    ]))
  })

  it('reports what a stopped session retained', async () => {
    const store = await open()
    const session = await store.startSession({ name: 's', origins: ['https://app.test'] })
    await store.appendExchange(exchange(session.id, 0))
    await store.appendExchange(exchange(session.id, 1))

    expect(await store.stopSession(session.id)).toEqual({ retained: 2 })
    expect((await store.session(session.id))?.session.stopped_at).toBeGreaterThan(0)
  })

  it('drops a session and everything recorded under it', async () => {
    const store = await open()
    const doomed = await store.startSession({ id: 'doomed', name: 'Doomed', origins: ['https://app.test'] })
    const kept = await store.startSession({ id: 'kept', name: 'Kept', origins: ['https://app.test'] })
    await store.appendExchange(exchange(doomed.id, 0))
    await store.appendExchange(exchange(kept.id, 0))
    await store.annotate(doomed.id, 'gone with it')

    await store.deleteSession(doomed.id)
    expect(await store.session(doomed.id)).toBeNull()
    expect(await store.countExchanges(doomed.id)).toBe(0)
    expect((await store.session(kept.id))?.exchanges).toHaveLength(1)
  })
})

/**
 * TR-6 — the one write path re-redacts and then refuses anything still credential-shaped. What
 * matters is the guarantee at the boundary: no credential is readable back out of the database,
 * whether it was replaced on the way in or the whole exchange was rejected.
 */
describe('the write gate (AC-CAP-005, TR-6)', () => {
  let name = ''
  let counter = 0

  beforeEach(() => {
    databases.clear()
    counter += 1
    name = `douze-gate-${counter}`
    globals['indexedDB'] = fakeIndexedDB
    globals['IDBKeyRange'] = FakeKeyRange
  })

  afterEach(() => {
    delete globals['indexedDB']
    delete globals['IDBKeyRange']
  })

  const withSession = async (): Promise<{ store: CaptureStore; id: string }> => {
    const store = await CaptureStore.open(name)
    const session = await store.startSession({ name: 's', origins: ['https://app.test'] })
    return { store, id: session.id }
  }

  it('lets no JWT through, in a header, in a body, or in a URL fragment', async () => {
    const { store, id } = await withSession()
    await store.appendExchange(exchange(id, 0, { request_headers: { 'x-trace': JWT } }))
    await store.appendExchange(exchange(id, 1, { response_body: { session_hint: JWT } }))
    await store.appendExchange(exchange(id, 2, { url: `https://app.test/cb#access_token=${JWT}&state=x` }))

    const detail = await store.session(id)
    const persisted = JSON.stringify(detail?.exchanges)
    expect(persisted).not.toContain(JWT)
    expect(persisted).toContain('«redacted:')
    expect(findSurvivingSecrets(detail?.exchanges)).toEqual([])
  })

  /**
   * The same token one slot over: as the query parameter NAME rather than its value, which is how
   * a URL carrying a set arrives. The gate walked query values only, so this was stored verbatim.
   */
  it('lets no JWT through as a query parameter name either', async () => {
    const { store, id } = await withSession()
    await store.appendExchange(exchange(id, 0, { url: `https://app.test/api/thing?${JWT}=1&page=2` }))

    const detail = await store.session(id)
    const persisted = JSON.stringify(detail?.exchanges)
    expect(persisted).not.toContain(JWT)
    expect(persisted).toContain('page=2')
    expect(findSurvivingSecrets(detail?.exchanges)).toEqual([])
  })

  /**
   * `credentials[]` is a list of LOCATIONS the pipeline discovered — a storage key, a header
   * name. Redaction does not walk it, so a hint carrying the value itself is only stopped by the
   * gate reading the full document. Scanning url + headers + bodies alone let this one to disk.
   */
  it('refuses an exchange whose credential hint carries the value', async () => {
    const { store, id } = await withSession()
    await expect(
      store.appendExchange(
        exchange(id, 0, { credentials: [{ header: 'authorization', expression: JWT, prefix: 'Bearer ' }] }),
      ),
    ).rejects.toThrow(/credential at/)
    expect(await store.countExchanges(id)).toBe(0)

    // An ordinary hint — a lookup, no value — still stores.
    await store.appendExchange(
      exchange(id, 0, {
        credentials: [{ header: 'authorization', expression: "localStorage.getItem('access_token')", prefix: 'Bearer ' }],
      }),
    )
    expect(await store.countExchanges(id)).toBe(1)
  })

  it('refuses a prefixed key hidden anywhere in the document', async () => {
    const { store, id } = await withSession()
    await expect(
      store.appendExchange(
        exchange(id, 0, {
          provenance: {
            accessible_name: 'Copy key',
            role: 'button',
            route: '/settings/api?k=sk_live_9f8e7d6c5b4a39281706',
            title: 'Settings',
          },
        }),
      ),
    ).rejects.toThrow(/credential at/)
  })
})

describe('annotation spans (AC-CAP-007.2)', () => {
  let name = ''
  let counter = 0

  beforeEach(() => {
    databases.clear()
    counter += 1
    name = `douze-span-${counter}`
    globals['indexedDB'] = fakeIndexedDB
    globals['IDBKeyRange'] = FakeKeyRange
  })

  afterEach(() => {
    delete globals['indexedDB']
    delete globals['IDBKeyRange']
  })

  it('scopes a span to the exchanges captured since the previous note', async () => {
    const store = await CaptureStore.open(name)
    const session = await store.startSession({ name: 's', origins: ['https://app.test'] })
    await store.appendExchange(exchange(session.id, 0))
    await store.appendExchange(exchange(session.id, 1))
    expect(await store.annotate(session.id, 'lists orders')).toMatchObject({ start_position: 0, end_position: 1 })

    await store.appendExchange(exchange(session.id, 2))
    expect(await store.annotate(session.id, 'transitions an issue')).toMatchObject({
      start_position: 2,
      end_position: 2,
    })

    const detail = await store.session(session.id)
    expect(detail?.annotations.map((a) => a.note)).toEqual(['lists orders', 'transitions an issue'])
  })

  it('records an empty span when nothing was captured since the last note', async () => {
    const store = await CaptureStore.open(name)
    const session = await store.startSession({ name: 's', origins: ['https://app.test'] })
    await store.appendExchange(exchange(session.id, 0))

    expect(await store.annotate(session.id, 'first')).toMatchObject({ start_position: 0, end_position: 0 })
    // Nothing new captured — the span must be empty, not claim the exchange that has not happened.
    const second = await store.annotate(session.id, 'second')
    expect(second.end_position).toBeLessThan(second.start_position)
  })

  it('anchors on the real maximum when positions are sparse', async () => {
    const store = await CaptureStore.open(name)
    const session = await store.startSession({ name: 's', origins: ['https://app.test'] })
    await store.appendExchange(exchange(session.id, 0))
    await store.appendExchange(exchange(session.id, 9))

    expect(await store.annotate(session.id, 'covers the gap')).toMatchObject({ start_position: 0, end_position: 9 })
  })
})
