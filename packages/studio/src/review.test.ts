import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Recipe, parseRecipe, serializeRecipe } from '@recon/shared'
import { StudioSession, baseUrlFrom, createApi, type StudioConfig } from './api.js'
import { readFixtures, toFixture, writeFixture } from './fixtures.js'
import { mergeRecipe } from './merge.js'
import { infer } from './inference/engine.js'
import { startStudio } from './server.js'
import { makeExchanges } from './testing.js'
import type { JsonSchema } from './types.js'

let home: string
let config: StudioConfig

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'recon-studio-'))
  config = {
    recipeName: 'orders',
    baseUrl: 'https://app.example.com',
    paths: { recipes: join(home, 'recipes'), fixtures: join(home, 'fixtures') },
  }
})

const mixedSession = () =>
  makeExchanges([
    { url: '/api/orders', response_body: { data: [{ id: 1, status: 'open' }] }, provenance: 'Orders' },
    { url: '/api/orders/1042', response_body: { data: { id: 1042, status: 'open' } } },
    { url: '/api/orders/1043', response_body: { data: { id: 1043, status: 'open' } } },
    { method: 'POST', url: '/api/orders', request_body: { sku: 'A' }, response_body: { data: { id: 3 } }, provenance: 'Create order' },
    { method: 'POST', url: '/api/orders', request_body: { sku: 'B' }, response_body: { data: { id: 4 } } },
    { method: 'DELETE', url: '/api/orders/1043', response_body: { data: { id: 1043 } }, provenance: 'Delete order' },
  ])

const session = () => StudioSession.fromExchanges(config, { exchanges: mixedSession() })

const readRecipe = () => {
  const path = join(home, 'recipes', 'orders.yaml')
  const result = parseRecipe(readFileSync(path, 'utf8'), 'orders.yaml')
  if (!result.ok || !result.recipe) throw new Error(result.error ?? 'unparsable recipe')
  return result.recipe
}

describe('AC-REC-002.1 review evidence', () => {
  it('lists every candidate with the evidence needed to decide', () => {
    const view = session().view()
    expect(view.map((c) => c.name).sort()).toEqual(['create_order', 'delete_order', 'get_order', 'list_orders'])

    const create = view.find((c) => c.name === 'create_order')
    expect(create).toMatchObject({
      side_effect: 'write',
      observations: 2,
      approved: false,
      bulk_approvable: false,
      provenance: 'Create order',
    })
    expect(create?.description.length).toBeGreaterThan(0)
    expect(create?.confidence).toBeGreaterThan(0)
    expect(create?.sample.status).toBe(200)
    expect(create?.sample.request_body).toEqual({ sku: 'A' })
  })

  it('reports the base url from the observed origin', () => {
    expect(baseUrlFrom(mixedSession())).toBe('https://app.example.com')
  })
})

describe('AC-REC-002.2 inline editing', () => {
  it('writes the edit and marks the field user_edited', () => {
    const studio = session()
    studio.edit('list_orders', 'description', 'Lists every order in the shop.')
    const candidate = studio.find('list_orders')

    expect(candidate.tool.description).toBe('Lists every order in the shop.')
    expect(candidate.tool.flags.user_edited).toEqual(['description'])

    studio.approveReads()
    studio.save()
    expect(readRecipe().tools.find((t) => t.name === 'list_orders')?.description).toBe('Lists every order in the shop.')
  })

  it('refuses an unknown candidate or an uneditable field', () => {
    const studio = session()
    expect(() => studio.edit('nope', 'description', 'x')).toThrow(/no candidate/)
    expect(() => studio.edit('list_orders', 'confidence' as 'name', 1)).toThrow(/not editable/)
  })
})

describe('COV_REC_002.1 bulk approval', () => {
  it('approves only read candidates on a mixed session', () => {
    const studio = session()
    const result = studio.approveReads()

    expect(result.approved.sort()).toEqual(['get_order', 'list_orders'])
    expect(result.skipped.sort()).toEqual(['create_order', 'delete_order'])
    expect(studio.candidates.filter((c) => c.tool.approved).map((c) => c.tool.name).sort()).toEqual([
      'get_order',
      'list_orders',
    ])
  })
})

describe('COV_REC_002.2 destructive approval', () => {
  it('injects a required confirm parameter and the recipe accepts it', () => {
    const studio = session()
    studio.approve('delete_order')
    const schema = studio.find('delete_order').tool.request.input_schema as JsonSchema

    expect(schema['required']).toContain('confirm')
    expect((schema['properties'] as Record<string, JsonSchema>)['confirm']?.['type']).toBe('boolean')

    studio.save()
    const written = readRecipe().tools.find((t) => t.name === 'delete_order')
    expect(written?.request.input_schema).toMatchObject({ required: expect.arrayContaining(['confirm']) })
  })

  it('is the only thing that lets a destructive tool serialize at all', () => {
    const studio = session()
    const tool = studio.find('delete_order').tool
    expect(() =>
      serializeRecipe(
        Recipe.parse({
          version: 1,
          name: 'orders',
          target: { base_url: 'https://app.example.com' },
          tools: [{ ...tool, approved: true, fixtures: ['orders/delete_order.json'] }],
        }),
      ),
    ).toThrow(/confirm/)
  })
})

describe('AC-REC-002.5 unapproved candidates', () => {
  it('records unapproved candidates with approved false and no fixture', () => {
    const studio = session()
    studio.approveReads()
    studio.save()
    const recipe = readRecipe()

    expect(recipe.tools.find((t) => t.name === 'create_order')?.approved).toBe(false)
    expect(recipe.tools.find((t) => t.name === 'create_order')?.fixtures).toEqual([])
    expect(recipe.tools.find((t) => t.name === 'list_orders')?.approved).toBe(true)
  })
})

describe('REQ-REC-004 fixtures', () => {
  it('stores one redacted fixture per approved tool', () => {
    const studio = session()
    studio.approveReads()
    const report = studio.save()

    expect(report.fixtures.sort()).toEqual([join('orders', 'get_order.json'), join('orders', 'list_orders.json')])
    expect(existsSync(join(home, 'fixtures', 'orders', 'list_orders.json'))).toBe(true)
    expect(readFixtures(join(home, 'fixtures'), 'orders').map((f) => f.tool).sort()).toEqual([
      'get_order',
      'list_orders',
    ])
    expect(readRecipe().tools.find((t) => t.name === 'list_orders')?.fixtures).toEqual([
      join('orders', 'list_orders.json'),
    ])
  })

  // AC-REC-004.2
  it('fails the write when a credential-shaped value survives redaction', () => {
    const exchange = makeExchanges([
      {
        url: '/api/handoff',
        response_body: { handoff: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFO' },
      },
    ])[0]
    if (!exchange) throw new Error('no exchange')
    expect(() => writeFixture(join(home, 'fixtures'), 'orders', toFixture('get_handoff', exchange))).toThrow(
      /credential-shaped value/,
    )
    expect(existsSync(join(home, 'fixtures', 'orders', 'get_handoff.json'))).toBe(false)
  })

  it('redacts credential headers into the stored fixture', () => {
    const exchange = makeExchanges([
      { url: '/api/orders', request_headers: { authorization: 'Bearer abc123', 'content-type': 'application/json' }, response_body: { data: [] } },
    ])[0]
    if (!exchange) throw new Error('no exchange')
    const fixture = toFixture('list_orders', exchange)
    expect(fixture.request.headers['authorization']).toMatch(/^«redacted:/)
    expect(fixture.request.headers['content-type']).toBe('application/json')
  })
})

describe('REQ-REC-003 non-destructive regeneration', () => {
  const reinfer = (exchanges = mixedSession()) => new StudioSession(config, infer({ exchanges }))

  // COV_REC_003.1
  it('keeps a user-edited description and stores the inferred one as a suggestion', () => {
    const first = session()
    first.edit('list_orders', 'description', 'Lists every order in the shop.')
    first.approveReads()
    first.save()

    const second = reinfer()
    const report = second.save()

    const merged = report.recipe.tools.find((t) => t.name === 'list_orders')
    expect(merged?.description).toBe('Lists every order in the shop.')
    expect(report.preserved).toContainEqual({ tool: 'list_orders', field: 'description' })
    expect(String(merged?.flags.suggestions['description'])).toContain('Returns')
    expect(readRecipe().tools.find((t) => t.name === 'list_orders')?.description).toBe('Lists every order in the shop.')
  })

  it('updates fields the user never touched', () => {
    const first = session()
    first.approveReads()
    first.save()

    const second = reinfer(
      makeExchanges([
        { url: '/api/orders', response_body: { data: [{ id: 1, status: 'open', total: 5 }] } },
        { url: '/api/orders', response_body: { data: [{ id: 2, status: 'open', total: 6 }] } },
      ]),
    )
    const merged = second.save().recipe.tools.find((t) => t.name === 'list_orders')
    expect(JSON.stringify(merged?.response.output_schema)).toContain('total')
    expect(merged?.observations).toBe(2)
  })

  // COV_REC_003.2
  it('retains a tool the new capture never observed, marked unverified with a last-observed date', () => {
    const first = session()
    first.approveReads()
    first.save()

    const second = reinfer(makeExchanges([{ url: '/api/orders', response_body: { data: [{ id: 1 }] } }]))
    const report = second.save()

    expect(report.retained).toContain('get_order')
    const retained = report.recipe.tools.find((t) => t.name === 'get_order')
    expect(retained?.flags.unverified).toBe(true)
    expect(retained?.flags.last_observed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(retained?.approved).toBe(true)
  })

  // AC-REC-003.3
  it('reports a fixture-invalidating schema change without overwriting the tool', () => {
    const first = session()
    first.approve('create_order')
    first.save()
    const before = readRecipe().tools.find((t) => t.name === 'create_order')

    const second = reinfer(
      makeExchanges([
        { method: 'POST', url: '/api/orders', request_body: { sku: 'A', title: 'x' }, response_body: { data: { id: 1 } } },
        { method: 'POST', url: '/api/orders', request_body: { sku: 'B', title: 'y' }, response_body: { data: { id: 2 } } },
      ]),
    )
    const report = second.save()

    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]?.tool).toBe('create_order')
    expect(report.conflicts[0]?.reason).toContain('title')
    expect(report.recipe.tools.find((t) => t.name === 'create_order')?.request.input_schema).toEqual(
      before?.request.input_schema,
    )
  })

  it('adds tools the previous recipe never had', () => {
    const first = session()
    first.approveReads()
    first.save()

    const existing = readRecipe()
    const fresh = infer({ exchanges: makeExchanges([{ url: '/api/refunds', response_body: { data: [] } }]) }).map(
      (c) => c.tool,
    )
    expect(mergeRecipe(existing, fresh).added).toEqual(['list_refunds'])
  })
})

describe('review HTTP API', () => {
  it('serves state, restricts bulk approval, and saves', async () => {
    const studio = session()
    const app = createApi(studio)

    const state = (await (await app.request('/api/state')).json()) as { candidates: { name: string }[] }
    expect(state.candidates).toHaveLength(4)

    const bulk = (await (await app.request('/api/approve-reads', { method: 'POST' })).json()) as {
      approved: string[]
      skipped: string[]
    }
    expect(bulk.approved.sort()).toEqual(['get_order', 'list_orders'])
    expect(bulk.skipped.sort()).toEqual(['create_order', 'delete_order'])

    const edit = await app.request('/api/candidates/list_orders/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'description', value: 'Edited via the API.' }),
    })
    // AC-REC-002.2 — the edit is on disk immediately, before any explicit save.
    expect((await edit.json()) as { user_edited: string[] }).toMatchObject({ ok: true, user_edited: ['description'] })
    expect(readRecipe().tools.find((t) => t.name === 'list_orders')?.description).toBe('Edited via the API.')

    const approve = await app.request('/api/candidates/delete_order/approve', { method: 'POST' })
    expect(JSON.stringify(await approve.json())).toContain('confirm')

    const save = (await (await app.request('/api/save', { method: 'POST' })).json()) as { path: string }
    expect(existsSync(save.path)).toBe(true)
    expect(readRecipe().tools.find((t) => t.name === 'list_orders')?.description).toBe('Edited via the API.')
  })

  it('serves the review SPA on loopback', async () => {
    const server = await startStudio(session())
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const html = await (await fetch(server.url)).text()
      expect(html).toContain('Recon Studio')
      expect(html).toContain('Approve all reads')
    } finally {
      await server.close()
    }
  })
})
