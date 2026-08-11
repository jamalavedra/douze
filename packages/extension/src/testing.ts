/**
 * The in-memory IndexedDB the extension's tests run against — one copy, used by `store.test.ts`,
 * `har.test.ts` and `background.test.ts`, which each carried their own transcription of it.
 *
 * The extension's vitest runs on plain Node with no jsdom, so browser globals are installed on
 * `globalThis` for the duration of a test — the same thing `relay.test.ts` does for `chrome.*`.
 * No IndexedDB implementation is available in this workspace and none is worth adding for one
 * module, so this covers exactly the surface `store.ts` uses: object stores keyed by `id`,
 * compound indexes, bound key ranges, `getAll`/`getAllKeys`, a backwards key cursor, and a
 * versioned open with `oldVersion`.
 *
 * It therefore exercises `store.ts`'s own logic — index choice, ranges, ordering, the write gate —
 * and proves nothing about a real browser's IndexedDB: transaction lifetimes, auto-commit,
 * structured-clone limits and quota behaviour are all out of its reach.
 *
 * Not a `*.test.ts` file on purpose: importing one would re-register that file's suites in
 * whichever test imported it.
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

export class FakeKeyRange {
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

/** How many times `upgrade()` has run since the last install — a reopen must not re-upgrade. */
export const upgradeCount = (): number => upgrades

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

export const fakeIndexedDB = {
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

/** Fresh databases and the two globals `store.ts` reaches for. Call it in `beforeEach`. */
export function installFakeIndexedDB(): void {
  databases.clear()
  upgrades = 0
  globals['indexedDB'] = fakeIndexedDB
  globals['IDBKeyRange'] = FakeKeyRange
}

/** Put the environment back, so a test that expects no IndexedDB still sees none. */
export function uninstallFakeIndexedDB(): void {
  delete globals['indexedDB']
  delete globals['IDBKeyRange']
}
