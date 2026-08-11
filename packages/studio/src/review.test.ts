import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Recipe, parseRecipe, serializeRecipe } from '@douze/shared'
import { StudioSession, authFrom, baseUrlFrom, type StudioConfig } from './api.js'
import { reviewPage } from './app.js'
import { readFixtures, toFixture, writeFixture } from './fixtures.js'
import { mergeRecipe } from './merge.js'
import { infer } from './inference/engine.js'
import { makeExchanges } from './testing.js'
import type { JsonSchema } from './types.js'

let home: string
let config: StudioConfig

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'douze-studio-'))
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
  /**
   * Redaction now catches a credential by its shape as well as its key name, so the fixture is
   * written with a placeholder instead of the write being refused outright. TR-6 is unchanged —
   * the value never reaches disk — but a site that returns API keys can be recorded at all.
   */
  it('redacts a credential-shaped value under an innocuous key rather than refusing the write', () => {
    const exchange = makeExchanges([
      {
        url: '/api/handoff',
        response_body: { handoff: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFO' },
      },
    ])[0]
    if (!exchange) throw new Error('no exchange')
    const path = writeFixture(join(home, 'fixtures'), 'orders', toFixture('get_handoff', exchange))
    const written = readFileSync(join(home, 'fixtures', path), 'utf8')
    expect(written).not.toContain('eyJhbGciOi')
    expect(written).toContain('«redacted:')
  })

  /** The write gate is defence in depth and still refuses anything handed to it unredacted. */
  it('refuses to write a fixture assembled without redaction', () => {
    const raw = { tool: 'get_handoff', request: { method: 'GET', path: '/api/handoff', headers: {} },
      response: { status: 200, body: { handoff: 'sk_live_9f8e7d6c5b4a39281706' } } }
    expect(() => writeFixture(join(home, 'fixtures'), 'orders', raw as never)).toThrow(/credential-shaped value/)
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

describe('the review page', () => {
  const html = () => reviewPage({ id: 'abc-123', token: 'tok-xyz' })

  it('inlines the session and token so its own fetches authenticate', () => {
    expect(html()).toContain('const SESSION = "abc-123"')
    expect(html()).toContain('const TOKEN = "tok-xyz"')
  })

  it('speaks plain English rather than the vocabulary of the recipe format', () => {
    const page = html()
    for (const copy of [
      'Choose what to keep',
      'Everything that only reads is selected. Turn on anything that makes changes.',
      'Look things up',
      'Make changes',
      'Remove things',
      'Only seen once',
      'Name is a guess',
      'Not checked yet',
      'Changes your account.',
      'Removes data. Asks first.',
      'Select all',
      'Clear',
      'Keep ',
      'skill',
      'Details',
    ]) {
      expect(page).toContain(copy)
    }
    // The developer vocabulary the old screen used must not be back on the first screen.
    expect(page).not.toContain('Approve')
    expect(page).not.toContain('confidence')
    // Nor may it name one client: the tools it turns on are for whichever MCP client is asking.
    expect(page).not.toContain('Claude')
  })

  /**
   * AC-REC-002.3 — the bulk API refuses to enable a write or a destructive tool, and the page must
   * not route around it. Pre-selecting everything meant one click on the primary button approved a
   * delete nobody had read.
   */
  it('seeds the selection with read-only skills, leaving the rest for a deliberate click', () => {
    expect(html()).toContain('if (candidate.bulk_approvable) chosen.add(candidate.name)')
  })

  it('explains each consequence with words rather than colour alone', () => {
    const page = html()
    expect(page).toContain('Read-only.')
    expect(page).toContain('Creates or updates data.')
    expect(page).toContain('Always asks first.')
  })

  it('selects every inferred skill by default and offers clear/select-all controls', () => {
    const page = html()
    expect(page).toContain('for (const candidate of state.candidates) chosen.add(candidate.name)')
    expect(page).toContain("byId('all').addEventListener")
    expect(page).toContain("byId('none').addEventListener")
  })

  it('keeps motion subtle and respects reduced-motion preferences', () => {
    const page = html()
    expect(page).toContain('details[open] > :not(summary)')
    expect(page).toContain('.primary:not(:disabled):hover')
    expect(page).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('uses the shared 12 mark and cyan/red palette', () => {
    const page = html()
    expect(page).toContain('class="brand-icon"')
    expect(page).toContain('data:image/png;base64,')
    expect(page).toContain('--brand-blue: #00bce8')
    expect(page).toContain('--brand-red: #f31b1b')
  })
})

/**
 * The recipe used to take the schema default — `cookie` — for every site, so a dashboard that
 * authenticates with a bearer token produced tools that all failed with "you have been signed
 * out" on their first call. The capture already knows better: the extension reports where the page
 * kept each credential it sent.
 */
describe('auth derived from the capture (AC-EXE-001.3)', () => {
  const captured = () =>
    makeExchanges([
      {
        url: 'https://api.example.com/v1/players',
        request_headers: { authorization: 'Bearer x', accept: 'application/json' },
        response_body: { data: [{ id: 'p1' }] },
      },
    ]).map((e) => ({
      ...e,
      page_origin: 'https://dashboard.example.com',
      credentials: [
        { header: 'Authorization', expression: 'JSON.parse(localStorage.getItem("sb-auth")).access_token', prefix: 'Bearer ' },
      ],
    }))

  it('emits a page_state source and the origin that must run the call', () => {
    const auth = authFrom(captured())
    expect(auth).toMatchObject({
      mode: 'browser_relay',
      page_origin: 'https://dashboard.example.com',
      credential_source: [
        {
          kind: 'page_state',
          header: 'Authorization',
          prefix: 'Bearer ',
          expression: 'JSON.parse(localStorage.getItem("sb-auth")).access_token',
        },
      ],
    })
  })

  /**
   * The trap that cost the live run: `mergeRecipe` builds on the existing recipe, so a recipe
   * first written with `cookie` kept it through every re-recording, and every call kept failing.
   */
  it('updates the auth of a recipe that already exists', () => {
    const config = { recipeName: 'again', baseUrl: 'https://api.example.com', paths: { recipes: join(home, 'recipes'), fixtures: join(home, 'fixtures') } }
    // First save: a capture with no page-supplied credential, so the schema default stands.
    const first = StudioSession.fromExchanges(config, {
      exchanges: makeExchanges([{ url: 'https://api.example.com/v1/players', response_body: { data: [] } }]),
      annotations: [],
    })
    first.approveReads()
    expect(readFileSync(first.save().path, 'utf8')).toContain('kind: cookie')

    // Recorded again, this time with the token located in the page.
    const second = StudioSession.fromExchanges(config, { exchanges: captured(), annotations: [] })
    second.approveReads()
    const written = readFileSync(second.save().path, 'utf8')
    expect(written).toContain('kind: page_state')
    expect(written).toContain('page_origin: https://dashboard.example.com')
    expect(written).not.toContain('kind: cookie')
  })

  it('leaves a cookie-authenticated capture on the schema default', () => {
    expect(authFrom(makeExchanges([{ url: '/api/orders', response_body: { data: [] } }]))).toBeUndefined()
  })

  it('reaches the saved recipe, so the relay is told at call time', () => {
    const session = StudioSession.fromExchanges(
      { recipeName: 'derived', baseUrl: 'https://api.example.com', paths: { recipes: join(home, 'recipes'), fixtures: join(home, 'fixtures') } },
      { exchanges: captured(), annotations: [] },
    )
    session.approveReads()
    const written = readFileSync(session.save().path, 'utf8')
    expect(written).toContain('page_state')
    expect(written).toContain('page_origin: https://dashboard.example.com')
    // A location, never a value — which is what lets it live in a committed file.
    expect(written).not.toContain('Bearer x')
  })
})

/**
 * A redacted path segment becomes `{project_key}`, filled by the page rather than the caller — so
 * a capture with no credential hint for it (every HAR import: they carry `credentials: []`) saved
 * a tool the relay could only ever call as `/v1/project/apikey//origins`.
 */
describe('a path credential nothing can fill (AC-EXE-001.3)', () => {
  const redactedPath = [
    {
      url: 'https://api.example.com/v1/project/apikey/«redacted:string:44»/origins',
      response_body: { data: [{ id: 'o1' }] },
    },
  ]

  const session = (extra: (e: ReturnType<typeof makeExchanges>[number]) => typeof e = (e) => e) =>
    StudioSession.fromExchanges(
      {
        recipeName: 'keyless',
        baseUrl: 'https://api.example.com',
        paths: { recipes: join(home, 'recipes'), fixtures: join(home, 'fixtures') },
      },
      { exchanges: makeExchanges(redactedPath).map(extra), annotations: [] },
    )

  it('degrades the candidate and says why when the capture carries no hint', () => {
    const [candidate] = session().candidates
    expect(candidate?.tool.request.path).toContain('{project_key}')
    expect(candidate?.tool.flags.degraded).toBe(true)
    expect(candidate?.tool.flags.degraded_reason).toContain('project_key')
  })

  it('leaves it alone when the page was seen supplying the key', () => {
    const [candidate] = session((e) => ({
      ...e,
      page_origin: 'https://dashboard.example.com',
      credentials: [{ segment: 4, expression: 'localStorage.getItem("pk")', prefix: '' }],
    })).candidates
    expect(candidate?.tool.request.path).toContain('{project_key}')
    expect(candidate?.tool.flags.degraded).toBe(false)
  })
})

describe('renaming a tool (AC-REC-003.1)', () => {
  it('recognises a renamed tool on re-inference instead of duplicating it', () => {
    const studio = session()
    studio.approveReads()
    const original = studio.candidates[0]!.tool.name
    studio.edit(original, 'name', 'find_open_orders')
    const saved = studio.save()
    expect(saved.recipe.tools.some((t) => t.name === 'find_open_orders')).toBe(true)

    // Re-infer the identical traffic: the rename must be recognised, not treated as a new tool.
    const again = session()
    again.approveReads()
    const report = again.save()

    const names = report.recipe.tools.map((t) => t.name)
    expect(names).toContain('find_open_orders')
    // The old name must NOT reappear as a second tool for the same endpoint.
    expect(names).not.toContain(original)
    expect(names.filter((n) => n === 'find_open_orders')).toHaveLength(1)

    // And it is not falsely marked unverified — its traffic was observed in this very capture.
    const renamed = report.recipe.tools.find((t) => t.name === 'find_open_orders')!
    expect(renamed.flags.unverified).toBe(false)
    // AC-REC-003.1 — the user's name is kept and the inferred alternative is a suggestion.
    expect(renamed.flags.user_edited).toContain('name')
  })
})
