import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Recipe, serializeRecipe } from '@douze/shared'
import { RecipeStore, type ExportedFile } from './recipes.js'

/**
 * The extension's vitest runs on plain Node with no browser globals, so `chrome` is installed on
 * `globalThis` for the duration of a test — the same thing `relay.test.ts` does, and the same
 * shape as `store.test.ts`'s IndexedDB fake. This one covers exactly what `recipes.ts` uses:
 * `storage.local.get/set/remove/getKeys` and `storage.onChanged`.
 *
 * Change events are delivered on a microtask, as Chrome delivers them after the `set` resolves —
 * which is why the store refreshes itself on its own writes rather than waiting for the echo.
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

/** One approved tool referencing one fixture — the minimum that reaches the Tool Surface. */
const recipeOf = (name: string, overrides: Record<string, unknown> = {}): Recipe =>
  Recipe.parse({
    version: 1,
    name,
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
        fixtures: [`${name}/list_orders.json`],
      },
    ],
    ...overrides,
  })

const fixtureOf = (tool: string): Record<string, unknown> => ({
  tool,
  recorded_at: '2026-01-01T00:00:00.000Z',
  request: { method: 'GET', url: 'https://api.test/orders', headers: {} },
  response: { status: 200, headers: {}, body: { orders: [{ id: 1, total: '12.00' }] } },
})

/** A tool whose static header carries the token itself — the thing the schema gate exists for. */
const LEAKY_YAML = `version: 1
name: leaky
target:
  base_url: https://api.test
tools:
  - name: whoami
    description: Who am I
    side_effect: read
    confidence: 0.9
    observations: 1
    approved: false
    request:
      method: GET
      path: /me
      headers:
        authorization: "Bearer ${JWT}"
`

const open = async (): Promise<RecipeStore> => RecipeStore.open()

/** Everything the store wrote, so a test can prove a rejected write left storage untouched. */
const storedNames = (): string[] =>
  [...items.keys()].filter((key) => key.startsWith('recipe:')).map((key) => key.slice('recipe:'.length))

beforeEach(() => {
  items.clear()
  listeners.clear()
  globals['chrome'] = fakeChrome
})

afterEach(() => {
  delete globals['chrome']
})

describe('recipes in extension storage (T-015.2)', () => {
  it('saves, lists, reads and deletes a recipe', async () => {
    const store = await open()
    expect(store.recipes()).toEqual([])

    const saved = await store.save(recipeOf('shop'))
    expect(saved.ok).toBe(true)
    await store.putFixture('shop', 'list_orders', fixtureOf('list_orders'))

    expect(store.recipes().map((r) => r.name)).toEqual(['shop'])
    expect(store.recipe('shop')?.target.base_url).toBe('https://api.test')
    expect(store.recipe('missing')).toBeNull()
    expect(await store.fixture('shop/list_orders.json')).toMatchObject({ tool: 'list_orders' })

    await store.delete('shop')
    expect(store.recipes()).toEqual([])
    // The fixtures go with it — an orphan fixture is unreachable and never collected otherwise.
    expect(await store.fixture('shop/list_orders.json')).toBeNull()
    expect(store.surface().tools).toEqual([])
  })

  it('survives a reopen, which is a fresh service worker', async () => {
    const first = await open()
    await first.save(recipeOf('shop'))
    await first.putFixture('shop', 'list_orders', fixtureOf('list_orders'))
    first.close()

    const second = await open()
    expect(second.surface().tools.map((t) => t.qualified_name)).toEqual(['shop_list_orders'])
  })

  it('builds the surface douzed built: qualified names, auth descriptor, no unapproved tools', async () => {
    const store = await open()
    await store.save(
      recipeOf('shop', {
        auth: { credential_source: [{ kind: 'page_state', expression: 'localStorage.getItem("t")' }] },
        tools: [
          ...recipeOf('shop').tools,
          {
            name: 'draft_order',
            description: 'Draft',
            side_effect: 'write',
            confidence: 0.5,
            observations: 1,
            approved: false,
            request: { method: 'POST', path: '/orders' },
          },
        ],
      }),
    )
    await store.putFixture('shop', 'list_orders', fixtureOf('list_orders'))

    const surface = store.surface()
    expect(surface.tools).toHaveLength(1)
    expect(surface.tools[0]).toMatchObject({
      qualified_name: 'shop_list_orders',
      recipe: 'shop',
      base_url: 'https://api.test',
      degraded: false,
    })
    expect(surface.tools[0]?.credential_source).toEqual([
      { kind: 'page_state', expression: 'localStorage.getItem("t")', prefix: '' },
    ])
  })

  it('exposes a disabled recipe to doctor but not to the surface (AC-RUN-001.4)', async () => {
    const store = await open()
    await store.save(recipeOf('shop', { enabled: false }))
    await store.putFixture('shop', 'list_orders', fixtureOf('list_orders'))
    expect(store.recipes()).toHaveLength(1)
    expect(store.surface().tools).toEqual([])
  })

  it('degrades a tool whose fixture is missing rather than dropping it (AC-RUN-001.5)', async () => {
    const store = await open()
    await store.save(recipeOf('shop'))

    expect(store.surface().tools[0]).toMatchObject({
      qualified_name: 'shop_list_orders',
      degraded: true,
      degraded_reason: 'fixture "shop/list_orders.json" is missing',
    })

    await store.putFixture('shop', 'list_orders', fixtureOf('list_orders'))
    expect(store.surface().tools[0]?.degraded).toBe(false)
  })
})

describe('a rejected recipe never reaches storage (AC-RUN-002.3, AC-REC-001.4)', () => {
  it('reports the failure by name and keeps the last valid version live', async () => {
    const store = await open()
    await store.save(recipeOf('shop'))
    await store.putFixture('shop', 'list_orders', fixtureOf('list_orders'))
    const before = store.surface()

    // An edit that dropped the fixture reference off an approved tool — the schema's own rule,
    // enforced by parseRecipe, not by a second validator living in the extension.
    const source = recipeOf('shop')
    const broken = serializeRecipe({
      ...source,
      tools: source.tools.map((tool) => ({ ...tool, fixtures: [] })),
    })
    const rejected = await store.save(broken, 'shop')

    expect(rejected.ok).toBe(false)
    expect(rejected.error).toMatch(/must reference at least one fixture/)
    expect(store.surface().errors).toEqual([{ recipe: 'shop', error: rejected.error }])
    // The live recipe is untouched: same tools, same revision, same bytes in storage.
    expect(store.surface().tools).toEqual(before.tools)
    expect(store.surface().revision).toBe(before.revision)
    expect(store.recipe('shop')?.tools[0]?.fixtures).toEqual(['shop/list_orders.json'])
  })

  it('rejects a recipe that is not YAML at all, by name', async () => {
    const store = await open()
    const rejected = await store.save('tools: [: :', 'shop')
    expect(rejected.ok).toBe(false)
    expect(store.surface().errors.map((e) => e.recipe)).toEqual(['shop'])
    expect(storedNames()).toEqual([])
  })

  it('refuses a fixture carrying a credential (TR-6)', async () => {
    const store = await open()
    await store.save(recipeOf('shop'))
    await expect(
      store.putFixture('shop', 'list_orders', { tool: 'list_orders', response: { body: { token: JWT } } }),
    ).rejects.toThrow(/credential at/)
    expect(await store.fixture('shop/list_orders.json')).toBeNull()
  })
})

describe('hot reload (T-015.2, AC-RUN-002.1)', () => {
  it('moves the revision and notifies subscribers when a save changes the surface', async () => {
    const store = await open()
    const seen: number[] = []
    store.subscribe((state) => seen.push(state.revision))

    await store.save(recipeOf('shop'))
    await store.putFixture('shop', 'list_orders', fixtureOf('list_orders'))

    expect(store.surface().revision).toBeGreaterThan(0)
    expect(seen).toEqual([1, 2])
    expect(seen.at(-1)).toBe(store.surface().revision)
  })

  it('does not move the revision when the set of callable tools is unchanged', async () => {
    const store = await open()
    await store.save(recipeOf('shop'))
    await store.putFixture('shop', 'list_orders', fixtureOf('list_orders'))
    const settled = store.surface().revision

    // Re-saving identical bytes, and a second fixture nothing references, change no tool.
    await store.save(recipeOf('shop'))
    await store.putFixture('shop', 'unreferenced', fixtureOf('unreferenced'))
    expect(store.surface().revision).toBe(settled)
  })

  it('picks up a write made by another extension context, through storage.onChanged', async () => {
    const store = await open()
    const changed = new Promise<number>((resolve) => {
      store.subscribe((state) => resolve(state.revision))
    })

    // No RecipeStore call — this is the review page writing while the worker holds the surface.
    await fakeChrome.storage.local.set({
      'recipe:shop': serializeRecipe(recipeOf('shop')),
      'fixture:shop/list_orders.json': fixtureOf('list_orders'),
    })

    expect(await changed).toBe(1)
    expect(store.surface().tools.map((t) => t.qualified_name)).toEqual(['shop_list_orders'])
  })

  it('stops listening once closed', async () => {
    const store = await open()
    store.close()
    await fakeChrome.storage.local.set({ 'recipe:shop': serializeRecipe(recipeOf('shop')) })
    await Promise.resolve()
    expect(store.surface().tools).toEqual([])
  })
})

describe('export and import (V-015.1)', () => {
  const populate = async (store: RecipeStore, name: string): Promise<void> => {
    await store.save(recipeOf(name))
    await store.putFixture(name, 'list_orders', fixtureOf('list_orders'))
  }

  it('exports the recipe as the YAML douzed reads, beside its fixtures', async () => {
    const store = await open()
    await populate(store, 'shop')

    const files = await store.exportRecipe('shop')
    expect(files.map((f) => f.path)).toEqual(['recipes/shop.yaml', 'fixtures/shop/list_orders.json'])
    // The exported recipe is the same bytes `~/.douze/recipes/shop.yaml` would hold.
    expect(files[0]?.content).toBe(serializeRecipe(recipeOf('shop')))
    expect(files[1]?.content.endsWith('\n')).toBe(true)
    expect(JSON.parse(files[1]?.content ?? '')).toMatchObject({ tool: 'list_orders' })
  })

  /**
   * The round trip is no longer byte-identical, and that is the fix rather than a regression: an
   * import lands unapproved whatever the file said, so the stored recipe says `approved: false`
   * where the exported one said true. Everything else — every file, in the same order, with the
   * same fixtures — still comes back.
   */
  it('round-trips through export → import → export, with nothing approved on the way back', async () => {
    const store = await open()
    await populate(store, 'shop')
    await populate(store, 'depot')
    const exported = await store.exportAll()

    items.clear()
    const fresh = await open()
    const imported = await fresh.importFiles(exported)
    expect(imported).toMatchObject({ ok: true, imported: ['depot', 'shop'], conflicts: [], errors: [] })

    const back = await fresh.exportAll()
    expect(back.map((f) => f.path)).toEqual(exported.map((f) => f.path))
    // The fixtures are byte-identical; only the recipes' approval changed.
    expect(back.filter((f) => f.path.endsWith('.json'))).toEqual(
      exported.filter((f) => f.path.endsWith('.json')),
    )
    for (const file of back.filter((f) => f.path.endsWith('.yaml'))) {
      expect(file.content).toContain('approved: false')
      expect(file.content).not.toContain('approved: true')
    }
    // AC-REC-002.5 — and therefore nothing on the surface until someone approves it.
    expect(fresh.surface().tools).toEqual([])
  })

  /**
   * #1 — the consent bypass. `approved` used to come out of the file, so someone sending a
   * colleague a .yaml put tools on their surface, and on every assistant attached to it, with no
   * review page, no tick boxes and no moment where a human read what they do.
   */
  it('lands an import unapproved however the file marked it, and stores it that way', async () => {
    const store = await open()
    const approved = serializeRecipe(recipeOf('shop'))
    expect(approved).toContain('approved: true')

    const result = await store.importFiles([
      { path: 'recipes/shop.yaml', content: approved },
      { path: 'fixtures/shop/list_orders.json', content: JSON.stringify(fixtureOf('list_orders')) },
    ])

    expect(result.ok).toBe(true)
    expect(store.recipe('shop')?.tools.map((t) => t.approved)).toEqual([false])
    expect(store.surface().tools).toEqual([])
    // Not just filtered on the way out: what is on disk says what is true.
    expect(String(items.get('recipe:shop'))).toContain('approved: false')
  })

  it('accepts a bare file picked out of ~/.douze, with no export directories', async () => {
    const store = await open()
    const files: ExportedFile[] = [
      { path: 'shop.yaml', content: serializeRecipe(recipeOf('shop')) },
      { path: 'shop/list_orders.json', content: `${JSON.stringify(fixtureOf('list_orders'), null, 2)}\n` },
    ]
    expect(await store.importFiles(files)).toMatchObject({ ok: true, imported: ['shop'], fixtures: ['shop/list_orders.json'] })
    // Unapproved, so it is not on the surface — the recipe and its fixture are both there.
    expect(store.recipe('shop')?.tools.map((t) => t.approved)).toEqual([false])
    expect(await store.fixture('shop/list_orders.json')).toMatchObject({ tool: 'list_orders' })
  })

  /**
   * #4 — conflict detection covered recipe NAMES only, and a fixture key comes straight out of
   * the file. An import shipping `fixtures/shop/list_orders.json` and no `shop` recipe replaced
   * the example answer a live approved tool depends on, silently.
   */
  it('refuses a fixture belonging to a recipe the import does not ship', async () => {
    const store = await open()
    await populate(store, 'shop')
    const original = await store.fixture('shop/list_orders.json')

    const result = await store.importFiles([
      { path: 'recipes/depot.yaml', content: serializeRecipe(recipeOf('depot')) },
      { path: 'fixtures/shop/list_orders.json', content: JSON.stringify({ tool: 'list_orders', planted: true }) },
    ])

    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/belongs to "shop"/)
    // Nothing is written unless the whole set validates: depot did not land either.
    expect(storedNames()).toEqual(['shop'])
    expect(await store.fixture('shop/list_orders.json')).toEqual(original)
  })

  it('reports a fixture it would replace as a conflict when its recipe is new', async () => {
    // An orphaned fixture — its recipe was deleted by hand, or never imported.
    await fakeChrome.storage.local.set({ 'fixture:shop/list_orders.json': fixtureOf('list_orders') })
    const fresh = await open()

    const files: ExportedFile[] = [
      { path: 'recipes/shop.yaml', content: serializeRecipe(recipeOf('shop')) },
      { path: 'fixtures/shop/list_orders.json', content: JSON.stringify({ tool: 'list_orders', replaced: true }) },
    ]
    expect(await fresh.importFiles(files)).toMatchObject({ ok: false, conflicts: ['shop/list_orders.json'] })
    expect(await fresh.fixture('shop/list_orders.json')).not.toMatchObject({ replaced: true })

    // AC-REC-003 — and taken once the reader says so, by name.
    expect(await fresh.importFiles(files, { overwrite: true })).toMatchObject({ ok: true })
    expect(await fresh.fixture('shop/list_orders.json')).toMatchObject({ replaced: true })
  })

  it('refuses a recipe carrying a credential value (AC-REC-001.2)', async () => {
    const store = await open()
    const result = await store.importFiles([{ path: 'recipes/leaky.yaml', content: LEAKY_YAML }])

    expect(result.ok).toBe(false)
    expect(result.errors.join()).toMatch(/credential-shaped value at/)
    expect(storedNames()).toEqual([])
    // The same gate on the direct path, so import is not the only place it fires.
    expect((await store.save(LEAKY_YAML, 'leaky')).error).toMatch(/credential-shaped value at/)
  })

  it('reports a name conflict instead of clobbering, and takes it with overwrite', async () => {
    const store = await open()
    await populate(store, 'shop')
    const mine = await store.exportAll()

    const theirs = serializeRecipe(recipeOf('shop', { target: { base_url: 'https://other.test' } }))
    const conflicted = await store.importFiles([{ path: 'recipes/shop.yaml', content: theirs }])
    expect(conflicted).toMatchObject({ ok: false, conflicts: ['shop'], imported: [] })
    expect(await store.exportAll()).toEqual(mine)

    const forced = await store.importFiles([{ path: 'recipes/shop.yaml', content: theirs }], { overwrite: true })
    expect(forced).toMatchObject({ ok: true, imported: ['shop'] })
    expect(store.recipe('shop')?.target.base_url).toBe('https://other.test')
  })

  it('writes nothing when one file of the set is bad', async () => {
    const store = await open()
    const result = await store.importFiles([
      { path: 'recipes/shop.yaml', content: serializeRecipe(recipeOf('shop')) },
      { path: 'fixtures/shop/list_orders.json', content: '{ not json' },
    ])
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(storedNames()).toEqual([])
  })
})
