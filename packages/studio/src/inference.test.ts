import { describe, expect, it } from 'vitest'
import type { Exchange } from '@douze/shared'
import { infer } from './inference/engine.js'
import { coerceNumericValues, inferSchema } from './inference/schema.js'
import { classify } from './inference/side-effects.js'
import { detectPagination, primaryPayloadPath } from './inference/payload.js'
import { score } from './inference/confidence.js'
import { groupEndpoints } from './inference/templating.js'
import { makeExchanges } from './testing.js'
import type { JsonSchema } from './types.js'

const byName = (candidates: ReturnType<typeof infer>, name: string) => {
  const found = candidates.find((c) => c.tool.name === name)
  if (!found) throw new Error(`no candidate ${name} in [${candidates.map((c) => c.tool.name).join(', ')}]`)
  return found
}

/** The declared parameters of the first candidate, which every schema assertion here reads. */
const inputProperties = (candidates: ReturnType<typeof infer>): Record<string, JsonSchema> => {
  const candidate = candidates[0]
  if (!candidate) throw new Error('no candidate')
  return (candidate.tool.request.input_schema as JsonSchema)['properties'] as Record<string, JsonSchema>
}

/**
 * A capture store outlives the code that filled it, and one unrepresentable exchange used to cost
 * the whole session: a stored `OPTIONS` (a CORS preflight, which a capture-filter bug briefly
 * admitted) reached `restCandidate`, the recipe schema refused the method, and the throw came out
 * of the review page as "Couldn't load what this site can do" — with every real candidate lost
 * behind it. Skipping what cannot become a tool is the difference between one missing row and a
 * blank screen.
 */
describe('an exchange that cannot become a tool', () => {
  it('is skipped rather than taking every other candidate down with it', () => {
    const exchanges = makeExchanges([
      { method: 'OPTIONS', url: '/orders', status: 204 },
      { url: '/orders', response_body: { orders: [{ id: 1 }] } },
    ])
    const candidates = infer({ exchanges })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.tool.request.method).toBe('GET')
  })
})

describe('REQ-INF-001 endpoint templating', () => {
  // COV_INF_001.1
  it('collapses /orders/1042|1043|1044 into one candidate named from the response id field', () => {
    const exchanges = makeExchanges([
      { url: '/orders/1042', response_body: { id: 1042, status: 'open' } },
      { url: '/orders/1043', response_body: { id: 1043, status: 'open' } },
      { url: '/orders/1044', response_body: { id: 1044, status: 'shipped' } },
    ])
    const candidates = infer({ exchanges })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.tool.request.path).toBe('/orders/{orderId}')
    expect(candidates[0]?.tool.name).toBe('get_order')
    expect(candidates[0]?.tool.observations).toBe(3)
  })

  // A route with a trailing slash is replayed with it: `/search/` is not `/search` to the server.
  it('keeps a trailing slash through templating', () => {
    const groups = groupEndpoints(
      makeExchanges([
        { url: '/search/?q=wallet', response_body: { hits: [] } },
        { url: '/orders/1042/', response_body: { id: 1042 } },
        { url: '/orders/1043/', response_body: { id: 1043 } },
      ]),
    )
    expect(groups.map((group) => group.path).sort()).toEqual(['/orders/{orderId}/', '/search/'])
  })

  // AC-INF-001.2 — the field itself names the parameter when it is not a bare `id`.
  it('takes the parameter name from a qualified id field', () => {
    const groups = groupEndpoints(
      makeExchanges([
        { url: '/v2/tickets/77', response_body: { ticket_id: 77 } },
        { url: '/v2/tickets/78', response_body: { ticket_id: 78 } },
      ]),
    )
    expect(groups[0]?.path).toBe('/v2/tickets/{ticketId}')
  })

  // AC-INF-001.3
  it('falls back to the singularised preceding segment when no evidence names the parameter', () => {
    const groups = groupEndpoints(
      makeExchanges([
        { url: '/invoices/a1/lines', response_body: { total: 1 } },
        { url: '/invoices/b2/lines', response_body: { total: 2 } },
      ]),
    )
    expect(groups[0]?.path).toBe('/invoices/{invoice}/lines')
  })

  it('keeps two distinct actions on the same resource apart', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { method: 'POST', url: '/orders/10/refund', request_body: { amount: 1 }, response_body: { id: 10 } },
        { method: 'POST', url: '/orders/11/refund', request_body: { amount: 2 }, response_body: { id: 11 } },
        { method: 'POST', url: '/orders/10/cancel', request_body: { reason: 'x' }, response_body: { id: 10 } },
      ]),
    })
    expect(candidates.map((c) => c.tool.request.path).sort()).toEqual([
      '/orders/{orderId}/cancel',
      '/orders/{orderId}/refund',
    ])
  })

  it('does not merge different resources of the same shape', () => {
    const groups = groupEndpoints(
      makeExchanges([
        { url: '/orders/1042', response_body: { id: 1042 } },
        { url: '/users/5', response_body: { id: 5 } },
      ]),
    )
    expect(groups).toHaveLength(2)
  })
})

describe('REQ-INF-002 schema inference', () => {
  // COV_INF_001.2
  it('marks a field seen in one of three observations optional and the rest required', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { method: 'POST', url: '/orders', request_body: { sku: 'A', qty: 1 }, response_body: { id: 1 } },
        { method: 'POST', url: '/orders', request_body: { sku: 'B', qty: 2, note: 'gift' }, response_body: { id: 2 } },
        { method: 'POST', url: '/orders', request_body: { sku: 'C', qty: 3 }, response_body: { id: 3 } },
      ]),
    })
    const schema = candidates[0]?.tool.request.input_schema as JsonSchema
    expect(schema['required']).toEqual(['qty', 'sku'])
    expect(Object.keys(schema['properties'] as object)).toContain('note')
  })

  // AC-INF-002.2
  it('emits an open enum for a small stable string set over three observations', () => {
    const schema = inferSchema([
      { status: 'open' },
      { status: 'closed' },
      { status: 'open' },
    ]) as JsonSchema
    const status = (schema['properties'] as Record<string, JsonSchema>)['status']
    expect(status?.['x-open-enum']).toBe(true)
    expect(status?.['examples']).toEqual(['closed', 'open'])
    // AC-INF-002.4 — no closed `enum`, so a JSON Schema → Zod conversion stays permissive.
    expect(status?.['enum']).toBeUndefined()
    expect(status?.['type']).toBe('string')
  })

  it('does not emit an enum below three observations or above twelve values', () => {
    expect(inferSchema(['a', 'b'])).toEqual({ type: 'string' })
    const many = Array.from({ length: 12 }, (_, i) => `v${i}`)
    expect(inferSchema(many)).toEqual({ type: 'string' })
  })

  // AC-INF-002.3
  it('caps a single-observation candidate at 0.4 confidence and marks it sparse', () => {
    const candidates = infer({
      exchanges: makeExchanges([{ method: 'POST', url: '/exports', request_body: { kind: 'csv' }, response_body: { id: 1 } }]),
    })
    expect(candidates[0]?.tool.flags.sparse).toBe(true)
    expect(candidates[0]?.tool.confidence).toBeLessThanOrEqual(0.4)
    expect(score({ observations: 1, stability: 1, sideEffect: 'read' })).toBeLessThanOrEqual(0.4)
  })

  // AC-INF-002.4
  it('emits plain JSON Schema types for nested structures', () => {
    expect(inferSchema([{ items: [{ sku: 'A', qty: 1 }] }])).toEqual({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { qty: { type: 'integer', minimum: -1000, maximum: 1000 }, sku: { type: 'string' } },
            required: ['qty', 'sku'],
          },
        },
      },
      required: ['items'],
    })
  })

  it('returns an unconstrained schema for mixed types rather than guessing', () => {
    expect(inferSchema(['a', 1])).toEqual({})
  })

  // WO-016 — an observed magnitude bounds what a caller may ask for.
  it('bounds an observed number with an order of magnitude of headroom', () => {
    expect(inferSchema([500, 250])).toEqual({ type: 'integer', minimum: -5000, maximum: 5000 })
    expect(inferSchema([12.5, -4000])).toEqual({ type: 'number', minimum: -40_000, maximum: 40_000 })
    // A small observation does not pin the ceiling to itself: the floor holds `page=1` open.
    expect(inferSchema([1])).toEqual({ type: 'integer', minimum: -1000, maximum: 1000 })
    expect(inferSchema([20, 20, 25])).toEqual({ type: 'integer', minimum: -1000, maximum: 1000 })
  })

  it('gives an observed query limit a ceiling that admits ordinary use and refuses absurd values', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { url: '/orders?limit=20', response_body: { data: [{ id: 1 }] } },
        { url: '/orders?limit=20', response_body: { data: [{ id: 2 }] } },
      ]),
    })
    const schema = byName(candidates, 'list_orders').tool.request.input_schema as JsonSchema
    const limit = (schema['properties'] as Record<string, JsonSchema>)['limit']
    expect(limit?.['type']).toBe('integer')
    expect(limit?.['maximum']).toBeGreaterThanOrEqual(50)
    expect(limit?.['maximum']).toBeLessThan(1_000_000)
  })

  it('leaves an identifier unbounded and a non-numeric query value a string', () => {
    const properties = (inferSchema([{ order_id: 1042, zip: '02138' }]) as JsonSchema)[
      'properties'
    ] as Record<string, JsonSchema>
    // Order 1042 says nothing about whether order 99999 exists.
    expect(properties['order_id']).toEqual({ type: 'integer' })
    expect(properties['zip']).toEqual({ type: 'string' })
    // A leading zero is not a number: coercing it would rewrite the value that goes back out.
    expect(coerceNumericValues({ zip: '02138', limit: '20', order_id: '1042' })).toEqual({
      zip: '02138',
      limit: 20,
      order_id: '1042',
    })
  })
})

describe('REQ-INF-003 side-effect classification', () => {
  // AC-INF-003.1
  it('labels GET and HEAD read, and other methods write', () => {
    expect(classify({ method: 'GET', path: '/orders' })).toBe('read')
    expect(classify({ method: 'HEAD', path: '/orders' })).toBe('read')
    expect(classify({ method: 'POST', path: '/orders' })).toBe('write')
    expect(classify({ method: 'PUT', path: '/orders/1' })).toBe('write')
    expect(classify({ method: 'PATCH', path: '/orders/1' })).toBe('write')
  })

  // AC-INF-003.2
  it('escalates destructive vocabulary in the path, the method, or a GraphQL operation', () => {
    expect(classify({ method: 'POST', path: '/orders/1/cancel' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/payments/1/refund' })).toBe('destructive')
    expect(classify({ method: 'DELETE', path: '/orders/{orderId}' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/graphql', operation: 'RevokeToken' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/graphql', operation: 'PurgeCache' })).toBe('destructive')
  })

  it('never escalates a read, so a cancelled-orders listing stays bulk approvable', () => {
    expect(classify({ method: 'GET', path: '/orders?status=cancelled' })).toBe('read')
  })

  // WO-016 — the vocabulary the six-word regex missed: a hosted assistant could reach all of these.
  it('escalates irreversible access, money and data changes the original vocabulary missed', () => {
    expect(classify({ method: 'POST', path: '/users/{userId}/suspend' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/payouts' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/keys/{keyId}/rotate' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/transfers' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/users/{userId}/password/reset' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/instances/{id}/terminate' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/webhooks/{id}/disable' })).toBe('destructive')
  })

  it('reads a camelCased GraphQL mutation name as words', () => {
    expect(classify({ method: 'POST', path: '/graphql', operation: 'deactivateAccount' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/graphql', operation: 'transferFunds' })).toBe('destructive')
    expect(classify({ method: 'POST', path: '/graphql', operation: 'wipeWorkspace' })).toBe('destructive')
    // The verb is not always the first word: `adminSuspendUser` is only visible once split.
    expect(classify({ method: 'POST', path: '/graphql', operation: 'adminSuspendUser' })).toBe('destructive')
    // A query is a read whatever it is called, so nothing here can make one unreachable.
    expect(classify({ method: 'GET', path: '/graphql', operation: 'transferHistory' })).toBe('read')
  })

  it('does not escalate a word that merely contains one of the verbs', () => {
    // A saved dashboard preset, POSTed because the filter set does not fit in a query string. It
    // contains "reset"; escalating it would put a tool nothing can undo out of reach for nothing.
    expect(classify({ method: 'POST', path: '/dashboards/{dashboardId}/preset' })).toBe('write')
    expect(classify({ method: 'POST', path: '/bank_accounts/verify' })).toBe('write')
  })
})

/**
 * Sites decorate their own URLs — reddit's search carries `screen_view_count=1&ext-referrer=DIRECT`
 * and wikipedia's `title=Special:Search`. Every observed query parameter used to be required, so
 * neither tool could be called without the agent inventing the decorations.
 */
describe('query parameters a site decorates its own URLs with', () => {
  it('makes every parameter of a single observation optional and carries its observed value', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { url: '/search/?q=wallet&screen_view_count=1&ext-referrer=DIRECT', response_body: { hits: [] } },
      ]),
    })
    const schema = candidates[0]?.tool.request.input_schema as JsonSchema
    expect(schema['required']).toBeUndefined()
    expect(inputProperties(candidates)['q']?.['default']).toBe('wallet')
    expect(inputProperties(candidates)['ext-referrer']?.['default']).toBe('DIRECT')
    expect(inputProperties(candidates)['screen_view_count']?.['default']).toBe(1)
  })

  it('keeps a parameter that varied required and gives it no default', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { url: '/search/?q=wallet&title=Special:Search', response_body: { hits: [1] } },
        { url: '/search/?q=ledger&title=Special:Search', response_body: { hits: [2] } },
      ]),
    })
    const schema = candidates[0]?.tool.request.input_schema as JsonSchema
    expect(schema['required']).toEqual(['q'])
    expect(inputProperties(candidates)['q']).not.toHaveProperty('default')
    expect(inputProperties(candidates)['title']?.['default']).toBe('Special:Search')
  })

  /**
   * A redacted value is a placeholder, not what the site sent. Resending `«redacted:string:8»` on
   * every call is worse than leaving the parameter to the caller.
   */
  it('gives no default to a parameter redaction replaced with a placeholder', () => {
    const candidates = infer({
      exchanges: makeExchanges([{ url: '/search/?q=wallet&token=«redacted:string:8»', response_body: { hits: [] } }]),
    })
    expect(inputProperties(candidates)['token']).not.toHaveProperty('default')
    expect(inputProperties(candidates)['q']?.['default']).toBe('wallet')
  })
})

describe('REQ-INF-005 response trimming', () => {
  // AC-INF-005.1
  it('selects a Primary Payload Path past the envelope', () => {
    expect(primaryPayloadPath([{ data: { items: [{ id: 1 }] } }])).toBe('$.data.items')
    expect(primaryPayloadPath([{ id: 1, name: 'a' }])).toBe('$')
  })

  it('shortens the path to one that holds for every observation', () => {
    expect(primaryPayloadPath([{ data: { items: [1] } }, { data: { id: 2, name: 'x' } }])).toBe('$.data')
  })

  // AC-INF-005.2
  it('records the pagination style and parameter', () => {
    expect(detectPagination([{ page: '1' }], [{}])).toEqual({ style: 'page', param: 'page' })
    expect(detectPagination([{ cursor: 'abc' }], [{ next_cursor: 'def' }])).toEqual({
      style: 'cursor',
      param: 'cursor',
      next_path: '$.next_cursor',
    })
    expect(detectPagination([{ offset: '20' }], [{}])).toEqual({ style: 'offset', param: 'offset' })
    expect(detectPagination([{}], [{}])).toBeUndefined()
  })

  it('never requires the pagination parameter of the caller', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { url: '/orders?page=1&status=open', response_body: { data: [{ id: 1 }] } },
        { url: '/orders?page=2&status=closed', response_body: { data: [{ id: 2 }] } },
      ]),
    })
    const schema = candidates[0]?.tool.request.input_schema as JsonSchema
    expect(schema['required']).not.toContain('page')
    expect(schema['required']).toContain('status')
  })

  /**
   * The runtime drives the page. A single recording of `?page=1` looks exactly like a parameter the
   * site never varies, and pinning the tool to page 1 by default would fight `detectPagination`.
   */
  it('gives the pagination parameter no default even when it never varied', () => {
    const candidates = infer({
      exchanges: makeExchanges([{ url: '/orders?page=1&status=open', response_body: { data: [{ id: 1 }] } }]),
    })
    expect(inputProperties(candidates)['page']).not.toHaveProperty('default')
    expect(inputProperties(candidates)['status']?.['default']).toBe('open')
  })

  // AC-INF-005.3
  it('exposes a raw parameter on every candidate', () => {
    const [candidate] = infer({ exchanges: makeExchanges([{ url: '/orders', response_body: { data: [] } }]) })
    if (!candidate) throw new Error('no candidate')
    const schema = candidate.tool.request.input_schema as JsonSchema
    expect((schema['properties'] as Record<string, JsonSchema>)['raw']?.['type']).toBe('boolean')
  })
})

describe('engine orchestration', () => {
  const session = () =>
    makeExchanges([
      { url: '/orders', response_body: { data: [{ id: 1 }] }, provenance: 'Orders' },
      { url: '/orders/1042', response_body: { data: { id: 1042 } } },
      { url: '/orders/1043', response_body: { data: { id: 1043 } } },
      { method: 'DELETE', url: '/orders/1043', response_body: { data: { id: 1043 } }, provenance: 'Delete' },
    ])

  it('is deterministic and replayable with no model call', () => {
    const first = infer({ exchanges: session() })
    const second = infer({ exchanges: session() })
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first))
  })

  it('traces every candidate to at least one exchange', () => {
    for (const candidate of infer({ exchanges: session() })) {
      expect(candidate.evidence.exchange_ids.length).toBeGreaterThan(0)
      expect(candidate.evidence.sample).toBeDefined()
    }
  })

  it('excludes failed exchanges from inference', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { url: '/orders', response_body: { data: [] } },
        { url: '/admin', status: 403, response_body: { error: 'forbidden' } },
      ]),
    })
    expect(candidates.map((c) => c.tool.request.path)).toEqual(['/orders'])
  })

  // AC-CAP-007.5 / AC-CAP-007.1
  it('attaches an annotation span to every candidate it covers, and nothing outside it', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { url: '/orders', response_body: { data: [] } },
        { method: 'POST', url: '/orders/9/close', request_body: { note: 'x' }, response_body: { id: 9 } },
        { method: 'POST', url: '/orders/9/reopen', request_body: { note: 'y' }, response_body: { id: 9 } },
      ]),
      annotations: [
        { id: 's1', session_id: 'test-session', note: 'closes and reopens a ticket', start_position: 1, end_position: 2 },
      ],
    })
    expect(byName(candidates, 'list_orders').tool.annotation).toBeUndefined()
    expect(byName(candidates, 'close_order').tool.annotation).toBe('closes and reopens a ticket')
    expect(byName(candidates, 'reopen_order').tool.annotation).toBe('closes and reopens a ticket')
  })

  // AC-CAP-007.4
  it('produces candidates from an unannotated session', () => {
    expect(infer({ exchanges: session() }).length).toBeGreaterThan(0)
  })

  // AC-CAP-003.3 — a background request carries no provenance to mislead the description.
  it('ignores provenance on background exchanges', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { url: '/poll', response_body: { data: [] }, background: true, provenance: 'Stale' },
      ]),
    })
    expect(candidates[0]?.evidence.provenance).toBeUndefined()
  })
})

/**
 * REQ-INF-006 — a soft-navigation site answers a route with HTML, and the capture pipeline stores
 * the semantic snapshot it extracted from it rather than the page. Those reads are tools too.
 */
describe('REQ-INF-006 document reads', () => {
  const snapshot = (query: string) => ({
    url: `https://app.example.com/search/?q=${query}`,
    title: `Results for ${query}`,
    text: `Two results for ${query}`,
    links: [
      { label: 'First result', url: 'https://app.example.com/posts/1' },
      { label: 'Second result', url: 'https://app.example.com/posts/2' },
    ],
  })

  /** `makeExchange` writes JSON; a document exchange differs only in what the reply announced. */
  const asDocument = (exchange: Exchange): Exchange => ({
    ...exchange,
    response_headers: { 'content-type': 'text/html; charset=utf-8' },
    response_content_type: 'text/html; charset=utf-8',
  })

  it('turns snapshots on one path into a read candidate carrying its query parameter', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { url: '/search/?q=wallet', response_body: snapshot('wallet') },
        { url: '/search/?q=ledger', response_body: snapshot('ledger') },
      ]).map(asDocument),
    })

    expect(candidates).toHaveLength(1)
    const tool = candidates[0]?.tool
    expect(tool?.request.path).toBe('/search/')
    expect(tool?.side_effect).toBe('read')
    const input = tool?.request.input_schema as JsonSchema
    expect((input['properties'] as Record<string, JsonSchema>)['q']?.['type']).toBe('string')
    // The snapshot is the payload: there is no envelope to trim past.
    expect(tool?.response.primary_payload_path).toBeUndefined()
    const output = tool?.response.output_schema as JsonSchema
    expect(Object.keys(output['properties'] as object).sort()).toEqual(['links', 'text', 'title', 'url'])
  })

  it('keeps a page and an API answering the same path apart', () => {
    const [json, document] = makeExchanges([
      { url: '/search/?q=wallet', response_body: { results: [{ id: 1 }] } },
      { url: '/search/?q=wallet', response_body: snapshot('wallet') },
    ])
    if (json === undefined || document === undefined) throw new Error('fixture')
    const candidates = infer({ exchanges: [json, asDocument(document)] })

    expect(candidates).toHaveLength(2)
    expect(candidates.map((c) => c.tool.request.path)).toEqual(['/search/', '/search/'])
  })

  /** REQ-017 — Hotwire and Reddit both answer a route with a `text/*html*` type of their own. */
  it('reads the rest of the HTML family as documents too', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        { url: '/search/?q=wallet', response_body: snapshot('wallet') },
        { url: '/search/?q=ledger', response_body: snapshot('ledger') },
      ]).map((exchange) => ({
        ...exchange,
        response_headers: { 'content-type': 'text/vnd.turbo-stream.html' },
        response_content_type: 'text/vnd.turbo-stream.html',
      })),
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.tool.response.primary_payload_path).toBeUndefined()
    const output = candidates[0]?.tool.response.output_schema as JsonSchema
    expect(Object.keys(output['properties'] as object).sort()).toEqual(['links', 'text', 'title', 'url'])
  })

  it('does not read a JSON body that happens to look like a snapshot as a document', () => {
    // A bookmarks API answering `{ url, title, text, links }` is JSON, and splitting it off from
    // the rest of its own path would make two tools out of one on four key names.
    const candidates = infer({
      exchanges: makeExchanges([
        { url: '/bookmarks/?q=wallet', response_body: snapshot('wallet') },
        { url: '/bookmarks/?q=ledger', response_body: { results: [{ id: 1 }] } },
      ]),
    })
    expect(candidates).toHaveLength(1)
  })
})
