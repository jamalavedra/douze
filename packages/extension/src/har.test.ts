import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import orders from '../../../fixtures/orders.har?raw'
import { findSurvivingSecrets } from '@douze/shared'
import { CaptureStore } from './store.js'
import { importHar } from './har.js'

/**
 * The extension's vitest runs on plain Node with no IndexedDB, so `store.test.ts`'s in-memory fake
 * is used here too — same surface, same key ordering. It is copied rather than imported because
 * importing a `*.test.ts` would re-register that file's suites; once both modules have landed the
 * fake is worth lifting into one test helper.
 *
 * The HAR under test is the real `fixtures/orders.har`, read through `?raw` so the daemon's e2e
 * fixture and this one cannot drift; the cases the fixture does not contain (a body-less entry, a
 * credential the write gate still catches) are built inline.
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

const globals = globalThis as Record<string, unknown>

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'

interface Entry {
  startedDateTime?: string
  time?: number
  request: { method: string; url: string; headers?: { name: string; value: string }[]; postData?: { text: string } }
  response: {
    status: number
    headers?: { name: string; value: string }[]
    /** `text` is explicitly optional-or-undefined: a body-less entry is one that omits it. */
    content: { mimeType: string; size?: number; text?: string | undefined; encoding?: string }
  }
}

const json = (url: string, body: unknown, overrides: Partial<Entry['response']['content']> = {}): Entry => ({
  startedDateTime: '2026-08-05T10:00:00.000Z',
  time: 10,
  request: { method: 'GET', url, headers: [] },
  response: {
    status: 200,
    headers: [{ name: 'content-type', value: 'application/json' }],
    content: { mimeType: 'application/json', size: 10, text: JSON.stringify(body), ...overrides },
  },
})

const har = (entries: Entry[]): unknown => ({ log: { version: '1.2', entries } })

describe('HAR import in the extension (T-015.5, REQ-CAP-006)', () => {
  let name = ''
  let counter = 0

  beforeEach(() => {
    databases.clear()
    counter += 1
    name = `douze-har-${counter}`
    globals['indexedDB'] = fakeIndexedDB
    globals['IDBKeyRange'] = FakeKeyRange
  })

  afterEach(() => {
    delete globals['indexedDB']
    delete globals['IDBKeyRange']
  })

  const open = (): Promise<CaptureStore> => CaptureStore.open(name)

  it('keeps only the JSON exchanges of the primary origin', async () => {
    const store = await open()
    const result = await importHar(JSON.parse(orders), 'orders-har', store)

    // The four app.test JSON calls survive; analytics, the stylesheet and the other-origin PNG do not.
    expect(result.imported).toBe(4)
    expect(result.skipped).toBe(3)
    expect(result.refused).toEqual([])

    const detail = await store.session(result.session_id)
    expect(detail?.session.origins).toEqual(['https://app.test'])
    const urls = detail?.exchanges.map((e) => e.url) ?? []
    expect(urls.every((u) => u.startsWith('https://app.test/api/'))).toBe(true)
    expect(urls.some((u) => u.includes('google-analytics') || u.endsWith('.css') || u.endsWith('.png'))).toBe(false)
    expect(detail?.exchanges.every((e) => e.source === 'har')).toBe(true)
  })

  it('turns credentials into placeholders on the way in', async () => {
    const store = await open()
    const result = await importHar(JSON.parse(orders), 'orders-har', store)
    const detail = await store.session(result.session_id)

    const first = detail?.exchanges[0]
    expect(first?.request_headers['authorization']).toMatch(/^«redacted:string:\d+»$/)
    expect(first?.request_headers['cookie']).toMatch(/^«redacted:string:\d+»$/)

    const persisted = JSON.stringify(detail)
    expect(persisted).not.toContain('super-secret-token-value-here')
    expect(persisted).not.toContain('abc123deadbeef')
    // The POST body's `password` field, which only the store's redaction ever saw.
    expect(persisted).not.toContain('hunter2')
    expect(findSurvivingSecrets(detail?.exchanges)).toEqual([])
  })

  it('marks a body-less entry rather than discarding it', async () => {
    const store = await open()
    const result = await importHar(
      har([
        json('https://app.test/api/a', { ok: true }),
        // No `text` at all, and a base64 body that is bytes rather than a payload.
        json('https://app.test/api/b', null, { text: undefined }),
        json('https://app.test/api/c', null, { text: 'iVBORw0KGgo=', encoding: 'base64' }),
      ]),
      'bodyless',
      store,
    )

    expect(result.imported).toBe(3)
    const detail = await store.session(result.session_id)
    const marked = detail?.exchanges.filter((e) => e.body_missing) ?? []
    expect(marked.map((e) => e.url)).toEqual(['https://app.test/api/b', 'https://app.test/api/c'])
    expect(marked.every((e) => e.body_missing_reason === 'har_no_content')).toBe(true)
    expect(marked.every((e) => e.response_body === undefined)).toBe(true)
  })

  /**
   * `response_content_type` is copied from the HAR's `mimeType` and no redactor touches it — the
   * write gate reads the whole record and is what catches this one. The import must neither abort
   * nor hide it.
   */
  it('reports an entry the write gate refuses and imports the rest', async () => {
    const store = await open()
    const poisoned = json('https://app.test/api/token', { ok: true }, { mimeType: `application/json;profile=${JWT}` })
    const result = await importHar(
      har([json('https://app.test/api/a', { a: 1 }), poisoned, json('https://app.test/api/b', { b: 2 })]),
      'poisoned',
      store,
    )

    expect(result.imported).toBe(2)
    expect(result.refused).toHaveLength(1)
    expect(result.refused[0]?.url).toBe('https://app.test/api/token')
    expect(result.refused[0]?.reason).toMatch(/credential at/)

    const detail = await store.session(result.session_id)
    expect(detail?.exchanges.map((e) => e.url)).toEqual(['https://app.test/api/a', 'https://app.test/api/b'])
    expect(JSON.stringify(detail)).not.toContain(JWT)
    // Refusals leave no gap: positions stay contiguous for the annotation spans that index them.
    expect(detail?.exchanges.map((e) => e.position)).toEqual([0, 1])
  })

  it('preserves the order of the file as positions', async () => {
    const store = await open()
    const urls = Array.from({ length: 12 }, (_, i) => `https://app.test/api/step/${i}`)
    const entries = urls.map((url, i) => ({
      ...json(url, { step: i }),
      // Timestamps deliberately descending: file order is what the session must keep.
      startedDateTime: new Date(1_800_000_000_000 - i * 1000).toISOString(),
    }))
    const result = await importHar(har(entries), 'ordered', store)

    expect(result.imported).toBe(12)
    const detail = await store.session(result.session_id)
    expect(detail?.exchanges.map((e) => e.position)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    expect(detail?.exchanges.map((e) => e.url)).toEqual(urls)
  })

  it('refuses to invent a session from a HAR with nothing importable', async () => {
    const store = await open()
    await expect(importHar({ log: { entries: [] } }, 'empty', store)).rejects.toThrow(/no entries/)
    await expect(
      importHar(har([json('https://cdn.test/logo.png', null, { mimeType: 'image/png' })]), 'assets', store),
    ).rejects.toThrow(/no importable JSON exchanges/)
    expect(await store.sessions()).toEqual([])
  })
})
