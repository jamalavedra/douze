import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Exchange } from '@douze/shared'
import { RecipeStore } from './recipes.js'
import { ReviewSession } from './review-session.js'
import type { CaptureStore, SessionDetail } from './store.js'

/**
 * `chrome.storage` is faked on `globalThis` for the duration of a test, the same way
 * `recipes.test.ts` and `relay.test.ts` do it — the RecipeStore under here is the real one, so
 * the recipe schema and both credential gates run exactly as they do in the extension.
 *
 * The capture store is a stub rather than the IndexedDB fake from `store.test.ts`: `ReviewSession`
 * calls one method on it (`session`), that fake proves nothing about this module, and the
 * credential case below is one the REAL store refuses to hold at all — its write gate would throw
 * on the way in. Reaching inference with an exchange like that is exactly what a future ingest
 * path bypassing the gate would do, and this is the layer that has to survive it.
 */

type Changes = Record<string, { newValue?: unknown; oldValue?: unknown }>

const items = new Map<string, unknown>()
const listeners = new Set<(changes: Changes, area: string) => void>()

const emit = (changes: Changes): void => {
  queueMicrotask(() => {
    for (const listener of listeners) listener(changes, 'local')
  })
}

const fakeChrome = {
  storage: {
    local: {
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
        emit(changes)
      },
      remove: async (keys: string | string[]): Promise<void> => {
        const changes: Changes = {}
        for (const key of typeof keys === 'string' ? [keys] : keys) {
          changes[key] = { oldValue: items.get(key) }
          items.delete(key)
        }
        emit(changes)
      },
    },
    onChanged: {
      addListener: (listener: (changes: Changes, area: string) => void): void => {
        listeners.add(listener)
      },
      removeListener: (listener: (changes: Changes, area: string) => void): void => {
        listeners.delete(listener)
      },
    },
  },
}

const globals = globalThis as Record<string, unknown>

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'

const exchange = (position: number, extra: Partial<Exchange> = {}): Exchange => ({
  id: `e-${position}`,
  session_id: 'cap',
  position,
  started_at: 1_700_000_000_000 + position,
  duration_ms: 5,
  method: 'GET',
  url: 'https://app.test/api/orders',
  origin: 'https://app.test',
  page_origin: 'https://app.test',
  request_headers: {},
  status: 200,
  response_headers: {},
  response_body: { orders: [{ id: 1, total: '12.00', state: 'paid' }] },
  body_missing: false,
  background: false,
  source: 'main_world',
  credentials: [],
  ...extra,
})

/** A capture of a dashboard: a list, a single record, and a create. */
const RECORDED: Exchange[] = [
  exchange(0),
  exchange(1, { url: 'https://app.test/api/orders?state=paid' }),
  exchange(2, { url: 'https://app.test/api/orders/42', response_body: { id: 42, total: '12.00' } }),
  exchange(3, { url: 'https://app.test/api/orders/43', response_body: { id: 43, total: '9.00' } }),
  exchange(4, {
    method: 'POST',
    url: 'https://app.test/api/orders',
    request_body: { total: '9.00' },
    status: 201,
    response_body: { id: 43 },
  }),
]

const detailOf = (exchanges: Exchange[], name = 'Shop orders'): SessionDetail => ({
  session: {
    id: 'cap',
    name,
    origins: ['https://app.test'],
    started_at: 1_700_000_000_000,
    debugger_enabled: false,
  },
  exchanges,
  annotations: [],
})

/** Only `session` is reached; anything else must fail loudly rather than pretend. */
const capturesOf = (detail: SessionDetail | null): CaptureStore =>
  ({ session: async (): Promise<SessionDetail | null> => detail }) as unknown as CaptureStore

const openReview = async (exchanges: Exchange[], name?: string): Promise<ReviewSession> => {
  const recipes = await RecipeStore.open()
  return ReviewSession.open('cap', { captures: capturesOf(detailOf(exchanges, name)), recipes })
}

/**
 * What the review page's seed does, in one line: approve every candidate it pre-selects, which is
 * the reads. There is no `approveReads()` on the session any more — see the class doc — so the
 * tests that only need "the reads are on" spell the same selection the page spells.
 */
const approveReads = (review: ReviewSession): void => {
  review.approve(review.candidates().filter((candidate) => candidate.bulk_approvable).map((c) => c.name))
}

const storedNames = (): string[] =>
  [...items.keys()].filter((key) => key.startsWith('recipe:')).map((key) => key.slice('recipe:'.length))

const storedFixtures = (): string[] => [...items.keys()].filter((key) => key.startsWith('fixture:'))

beforeEach(() => {
  items.clear()
  listeners.clear()
  globals['chrome'] = fakeChrome
})

afterEach(() => {
  delete globals['chrome']
})

describe('review inside the extension (T-015.3)', () => {
  it('turns a recorded capture into named candidates', async () => {
    const review = await openReview(RECORDED)

    expect(review.site()).toBe('app.test')
    expect(review.recipeName()).toBe('shop-orders')
    const candidates = review.candidates()
    expect(candidates.map((c) => c.name)).toEqual(['create_order', 'get_order', 'list_orders'])
    expect(candidates.map((c) => c.side_effect)).toEqual(['write', 'read', 'read'])
    // Deterministic descriptions, written by the engine with no model call anywhere.
    expect(candidates.find((c) => c.name === 'list_orders')?.description).toMatch(/^Lists orders/)
    expect(candidates.every((c) => c.approved)).toBe(false)
    // AC-REC-002.3 — a write is not bulk-approvable.
    expect(candidates.find((c) => c.name === 'create_order')?.bulk_approvable).toBe(false)
  })

  it('names a recipe the schema will take even when the capture was not named like one', async () => {
    const review = await openReview(RECORDED, '2026 Audit!')
    expect(review.recipeName()).toBe('recipe-2026-audit')
  })

  /**
   * Approval is by name and only by name. `bulk_approvable` is what the review page seeds its
   * selection from (AC-REC-002.3, now a UI default — see the class doc), so it is asserted here as
   * the data behind that seed rather than as a method the session enforces.
   */
  it('approves and unapproves named candidates, and marks only reads as bulk-approvable', async () => {
    const review = await openReview(RECORDED)

    expect(review.candidates().filter((c) => c.bulk_approvable).map((c) => c.name)).toEqual([
      'get_order',
      'list_orders',
    ])
    approveReads(review)
    const approved = (): string[] => review.candidates().filter((c) => c.approved).map((c) => c.name)
    expect(approved()).toEqual(['get_order', 'list_orders'])

    review.approve(['create_order'])
    expect(approved()).toEqual(['create_order', 'get_order', 'list_orders'])

    review.unapprove(['create_order', 'get_order'])
    expect(approved()).toEqual(['list_orders'])
    expect(() => review.approve(['no_such_tool'])).toThrow(/no candidate named/)
  })

  it('saves a recipe the store accepts, with fixtures it can read back', async () => {
    const recipes = await RecipeStore.open()
    const review = await ReviewSession.open('cap', { captures: capturesOf(detailOf(RECORDED)), recipes })

    approveReads(review)
    expect(await review.save()).toEqual({ recipe: 'shop-orders', tools: 2 })

    const recipe = recipes.recipe('shop-orders')
    expect(recipe?.target.base_url).toBe('https://app.test')
    expect(recipe?.tools.filter((t) => t.approved).map((t) => t.name)).toEqual(['get_order', 'list_orders'])
    expect(recipe?.tools.find((t) => t.name === 'list_orders')?.fixtures).toEqual([
      'shop-orders/list_orders.json',
    ])
    // The fixture is a real redacted exchange, and it is what makes the tool callable.
    expect(await recipes.fixture('shop-orders/list_orders.json')).toMatchObject({
      tool: 'list_orders',
      response: { status: 200 },
    })
    expect(recipes.surface().tools.map((t) => t.qualified_name)).toEqual([
      'shop-orders_get_order',
      'shop-orders_list_orders',
    ])
    expect(recipes.surface().tools.every((t) => t.degraded)).toBe(false)
  })

  it('writes what an edit changed, not what was inferred', async () => {
    const recipes = await RecipeStore.open()
    const review = await ReviewSession.open('cap', { captures: capturesOf(detailOf(RECORDED)), recipes })

    review.approve(['list_orders'])
    review.edit('list_orders', 'description', 'Lists the orders a customer placed today.')
    review.edit('list_orders', 'name', 'todays_orders')
    expect(await review.save()).toEqual({ recipe: 'shop-orders', tools: 1 })

    // Unapproved candidates are saved too — they are what a later review comes back to — so the
    // edited one is found by its new name rather than by position.
    const tool = recipes.recipe('shop-orders')?.tools.find((t) => t.approved)
    expect(tool?.name).toBe('todays_orders')
    expect(tool?.description).toBe('Lists the orders a customer placed today.')
    // AC-REC-002.2 — the edit is marked, so re-inference will not clobber it.
    expect(tool?.flags.user_edited).toEqual(['description', 'name'])
    expect(await recipes.fixture('shop-orders/todays_orders.json')).toMatchObject({ tool: 'todays_orders' })
  })

  it('refuses to write an empty recipe for a capture with nothing in it', async () => {
    const review = await openReview([])

    expect(review.candidates()).toEqual([])
    await expect(review.save()).rejects.toThrow(/nothing is approved/)
    expect(storedNames()).toEqual([])
    expect(storedFixtures()).toEqual([])
  })

  it('refuses to save when nothing was approved, however much was captured', async () => {
    const review = await openReview(RECORDED)
    await expect(review.save()).rejects.toThrow(/nothing is approved/)
    expect(storedNames()).toEqual([])
  })
})

describe('a capture carrying a credential cannot become a recipe (TR-6)', () => {
  /** The hint carries the token itself rather than where the page kept it. */
  const leakedAuth = RECORDED.map((e) =>
    exchange(e.position, { ...e, credentials: [{ header: 'Authorization', expression: JWT, prefix: 'Bearer ' }] }),
  )

  it('fails on the recipe gate before a single fixture is written', async () => {
    const review = await openReview(leakedAuth)
    approveReads(review)

    // The auth block is what the capture implies, so the token would land in the recipe itself.
    await expect(review.save()).rejects.toThrow(/credential at \$\.auth\.credential_source\[0\]\.expression/)
    expect(storedNames()).toEqual([])
    expect(storedFixtures()).toEqual([])
  })

  it('redacts a token out of the URL on its way into a fixture rather than writing it out', async () => {
    const review = await openReview([
      exchange(0, { url: `https://app.test/api/orders?share=${JWT}` }),
      exchange(1, { url: `https://app.test/api/orders?share=${JWT}x` }),
    ])
    approveReads(review)

    // `toFixture` copied `exchange.url` verbatim while re-redacting the headers and bodies beside
    // it, so the token reached a file `exportRecipe` writes out.
    await expect(review.save()).resolves.toMatchObject({ recipe: 'shop-orders' })
    expect(storedFixtures().length).toBeGreaterThan(0)
    expect(JSON.stringify([...items.entries()])).not.toContain(JWT)
  })

  it('refuses when the token is the query parameter NAME, which reaches the schema itself', async () => {
    const review = await openReview([
      exchange(0, { url: `https://app.test/api/orders?${JWT}=1&page=2` }),
      exchange(1, { url: `https://app.test/api/orders?${JWT}=1&page=3` }),
    ])
    approveReads(review)

    // A parameter name becomes an `input_schema` property, so this one is caught by the recipe
    // gate before any fixture is written — and the gate sees it only because `findSurvivingSecrets`
    // walks keys as well as values.
    await expect(review.save()).rejects.toThrow(/credential at/)
    expect(storedNames()).toEqual([])
    expect(storedFixtures()).toEqual([])
  })
})

/**
 * WO-016 #1 — the other half of "an import lands unapproved". Forcing `approved: false` on import
 * is only honest if there is somewhere for the reader to go, and every review route named a
 * capture session while an imported recipe has no capture behind it. This is that route: the same
 * page, the same tick boxes, the same `save()`.
 */
describe('reviewing an imported recipe (WO-016)', () => {
  const IMPORTED = `version: 1
name: shop
target:
  base_url: https://app.test
tools:
  - name: list_orders
    description: Lists orders.
    side_effect: read
    confidence: 0.9
    observations: 3
    approved: false
    request:
      method: GET
      path: /api/orders
  - name: delete_order
    description: Deletes an order.
    side_effect: destructive
    confidence: 0.9
    observations: 1
    approved: false
    request:
      method: DELETE
      path: /api/orders/{id}
`

  const importIt = async (): Promise<RecipeStore> => {
    const recipes = await RecipeStore.open()
    const result = await recipes.importFiles([
      { path: 'recipes/shop.yaml', content: IMPORTED },
      {
        path: 'fixtures/shop/list_orders.json',
        content: JSON.stringify({
          tool: 'list_orders',
          recorded_at: '2026-01-01T00:00:00.000Z',
          request: { method: 'GET', url: 'https://app.test/api/orders', headers: {} },
          response: { status: 200, headers: {}, body: { orders: [{ id: 1, total: '12.00' }] } },
        }),
      },
    ])
    expect(result.ok, result.errors.join('; ')).toBe(true)
    return recipes
  }

  it('shows the file’s own tools as candidates, with the fixture it shipped as the evidence', async () => {
    const recipes = await importIt()
    const review = await ReviewSession.openRecipe('shop', { recipes })

    expect(review.site()).toBe('app.test')
    expect(review.recipeName()).toBe('shop')
    const candidates = review.candidates()
    expect(candidates.map((c) => c.name)).toEqual(['list_orders', 'delete_order'])
    // Nothing arrives ticked, and a destructive tool is never bulk-approvable (AC-REC-002.3).
    expect(candidates.every((c) => c.approved)).toBe(false)
    expect(candidates.map((c) => c.bulk_approvable)).toEqual([true, false])
    expect(candidates[0]?.sample.response_body).toEqual({ orders: [{ id: 1, total: '12.00' }] })
    // A tool the file shipped no example answer for still appears, saying what it would do.
    expect(candidates[1]?.sample.status).toBe(0)
    expect(candidates[1]?.sample.url).toContain('/api/orders/')
  })

  it('puts an imported tool on the surface only once it has been approved here', async () => {
    const recipes = await importIt()
    expect(recipes.surface().tools).toEqual([])

    const review = await ReviewSession.openRecipe('shop', { recipes })
    review.approve(['list_orders'])
    await expect(review.save()).resolves.toMatchObject({ recipe: 'shop', tools: 1 })

    expect(recipes.surface().tools.map((t) => t.qualified_name)).toEqual(['shop_list_orders'])
    expect(recipes.recipe('shop')?.tools.find((t) => t.name === 'list_orders')?.approved).toBe(true)
    // The one left unticked stays off, and stays present.
    expect(recipes.recipe('shop')?.tools.find((t) => t.name === 'delete_order')?.approved).toBe(false)
  })

  /**
   * `mergeRecipe` keeps `approved` from the stored side, because it exists to stop re-inference
   * clobbering what is stored. Merging a recipe against ITSELF is not that: every tick the reader
   * just made would be merged straight back out, and `save()` would report success having changed
   * nothing. This is the regression test for that, not a restatement of the one above.
   */
  it('does not merge the reader’s approvals away against the recipe they came from', async () => {
    const recipes = await importIt()
    const review = await ReviewSession.openRecipe('shop', { recipes })
    review.approve(['list_orders'])
    await review.save()

    // Re-open: the store is the only state that survived, and it must say list_orders is on.
    const again = await ReviewSession.openRecipe('shop', { recipes })
    expect(again.candidates().filter((c) => c.approved).map((c) => c.name)).toEqual(['list_orders'])
  })

  it('approving a destructive imported tool injects the confirm the schema demands (AC-REC-002.4)', async () => {
    const recipes = await importIt()
    const review = await ReviewSession.openRecipe('shop', { recipes })
    review.approve(['delete_order'])
    await expect(review.save()).resolves.toMatchObject({ recipe: 'shop' })

    const tool = recipes.recipe('shop')?.tools.find((t) => t.name === 'delete_order')
    expect((tool?.request.input_schema as { required?: string[] } | undefined)?.required).toContain('confirm')
  })

  it('refuses to review a recipe that is not there', async () => {
    const recipes = await RecipeStore.open()
    await expect(ReviewSession.openRecipe('nope', { recipes })).rejects.toThrow(/no recipe "nope"/)
  })
})
