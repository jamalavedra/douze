import { describe, expect, it } from 'vitest'
import { Exchange, NOISE_HOSTS, findSurvivingSecrets } from '@douze/shared'
import type { GestureEvent } from './messages.js'
import {
  PROVENANCE_WINDOW_MS,
  RECONCILE_GRACE_MS,
  Reconciler,
  admits,
  attribute,
  decodeBody,
  finalize,
  type ExchangeDraft,
} from './pipeline.js'

const gesture = (t: number): GestureEvent => ({
  type: 'gesture',
  accessible_name: 'Create order',
  role: 'button',
  route: '/orders',
  title: 'Orders',
  t,
})

const draft = (over: Partial<ExchangeDraft> = {}): ExchangeDraft => ({
  method: 'GET',
  url: 'https://app.example/api/orders',
  started_at: 1_000,
  duration_ms: 12,
  request_headers: {},
  status: 200,
  response_headers: { 'content-type': 'application/json' },
  response_content_type: 'application/json',
  body_missing: false,
  source: 'main_world',
  ...over,
})

describe('decodeBody', () => {
  it('parses JSON payloads so redaction can walk them', () => {
    expect(decodeBody({ text: '{"a":1}' }, 'application/json')).toEqual({ value: { a: 1 }, size: 7 })
  })

  it('keeps unparseable JSON as text rather than losing it', () => {
    expect(decodeBody({ text: 'not json' }, 'application/json').value).toBe('not json')
  })

  it('reports size and reason instead of the body when it is not UTF-8 (AC-CAP-002.2)', () => {
    expect(decodeBody({ binary: 4096 }, 'image/png')).toEqual({ missing: 'not_utf8', size: 4096 })
  })

  it('marks an over-cap body too_large', () => {
    expect(decodeBody({ text: 'x'.repeat(10), truncated: true }).missing).toBe('too_large')
  })

  it('treats an absent body as absent, not missing', () => {
    expect(decodeBody(null)).toEqual({})
  })
})

describe('attribute (AC-CAP-003)', () => {
  it('attaches the gesture that preceded the request inside the window', () => {
    const result = attribute(5_000, gesture(4_000))
    expect(result).toEqual({
      provenance: { accessible_name: 'Create order', role: 'button', route: '/orders', title: 'Orders' },
    })
  })

  it('marks background rather than attaching a stale gesture (AC-CAP-003.3)', () => {
    expect(attribute(5_000, gesture(5_000 - PROVENANCE_WINDOW_MS - 1))).toEqual({ background: true })
  })

  it('marks background when no gesture happened at all', () => {
    expect(attribute(5_000, undefined)).toEqual({ background: true })
  })

  it('ignores a gesture that happened after the request started', () => {
    expect(attribute(5_000, gesture(6_000))).toEqual({ background: true })
  })

  it('accepts a gesture exactly on the window boundary', () => {
    expect(attribute(5_000, gesture(5_000 - PROVENANCE_WINDOW_MS))).toHaveProperty('provenance')
  })
})

describe('admits (AC-CAP-004)', () => {
  it('keeps a JSON exchange on the recorded origin', () => {
    expect(admits(draft())).toBe(true)
  })

  it('drops a third-party analytics request (AC-CAP-004.1)', () => {
    expect(admits(draft({ url: 'https://www.google-analytics.com/collect' }))).toBe(false)
  })

  it('drops a CSS asset (AC-CAP-004.2)', () => {
    const css = draft({ url: 'https://app.example/app.css', response_content_type: 'text/css' })
    expect(admits(css)).toBe(false)
  })

  /**
   * The case that made a real dashboard record nothing at all: `dashboard.example` serves the
   * page and `api.example` answers every call it makes. Only the recorded tab's requests reach
   * here, so a different host is the API, not somebody else's traffic.
   */
  it('keeps the API call a page makes to another host (AC-CAP-001.1)', () => {
    expect(admits(draft({ url: 'https://api.example/v1/orders' }))).toBe(true)
  })

  it('still drops noise on another host', () => {
    expect(admits(draft({ url: 'https://cdn.segment.com/v1/track' }))).toBe(false)
  })

  it('honours a user addition to the noise list (AC-CAP-004.3)', () => {
    const beacon = draft({ url: 'https://app.example/metrics/collect' })
    expect(admits(beacon)).toBe(true)
    expect(admits(beacon, { hosts: [...NOISE_HOSTS, 'app.example'] })).toBe(false)
  })

  /**
   * The reported bug, at the layer that dropped it: a `PUT` answering `204 No Content` carries no
   * content type, and this returned false for it while every GET sailed through — so writes went
   * missing from recordings with nothing logged and the popup's counter never moving.
   */
  it('keeps a write whose response had no body (204 No Content)', () => {
    // The key is REMOVED rather than set to undefined: that is the shape a 204 actually produces,
    // and `exactOptionalPropertyTypes` is right to refuse the other one.
    const bodiless = (over: Partial<ExchangeDraft>): ExchangeDraft => {
      const { response_content_type: _none, ...rest } = draft({ status: 204, response_headers: {}, ...over })
      return rest
    }
    expect(admits(bodiless({ method: 'PUT' }))).toBe(true)
    expect(admits(bodiless({ method: 'POST', status: 201, response_headers: { location: '/orders/42' } }))).toBe(true)
    // Unchanged for reads, and unchanged for a write that did answer something unreadable.
    expect(admits(bodiless({ method: 'GET' }))).toBe(false)
    expect(admits(draft({ method: 'POST', response_content_type: 'text/css' }))).toBe(false)
  })
})

describe('finalize', () => {
  const ctx = { session_id: 's1', position: 3, gesture: gesture(999) }

  /**
   * `provenance` was the one field written to disk without passing through redaction, while the
   * write gate walked it exactly like every other field. On a dashboard whose own URLs carry a
   * project key — `/projects/pk_live_…/players` — that refused EVERY exchange in the session at
   * `$.provenance.route`, so the counter never moved and the recording came out empty. Silently:
   * the refusal is a `console.warn` in the worker and nothing on screen.
   */
  it('redacts the route it stores, so a key in the page URL cannot refuse the whole session', () => {
    const route = '/projects/pk_live_9aF3kQ2mZx7bV1nR8tYuI0pLsDcG/players'
    const exchange = finalize(draft(), { ...ctx, gesture: { ...gesture(999), route } }, 'x9')

    expect(exchange.provenance?.route).not.toContain('pk_live_9aF3kQ2mZx7bV1nR8tYuI0pLsDcG')
    // Redacted, not discarded: the surrounding segments are what make the route worth keeping.
    expect(exchange.provenance?.route).toContain('/projects/')
    expect(exchange.provenance?.route).toContain('/players')
    // The gate is what actually refused; this is the assertion that would have caught it.
    expect(findSurvivingSecrets(exchange)).toEqual([])
  })

  it('leaves an ordinary route and control name alone', () => {
    const exchange = finalize(draft(), ctx, 'x10')
    expect(exchange.provenance?.route).toBe('/orders')
    expect(exchange.provenance?.accessible_name).toBe('Create order')
    expect(exchange.provenance?.title).toBe('Orders')
  })

  it('redacts credential headers and secret fields before the exchange leaves (REQ-CAP-005)', () => {
    const exchange = finalize(
      draft({
        request_headers: { authorization: 'Bearer sk_live_abcdefghijklmnopqrst', accept: 'application/json' },
        request_body: { password: 'hunter2hunter2', name: 'ada' },
      }),
      ctx,
      'x1',
    )
    expect(exchange.request_headers['authorization']).toBe('«redacted:string:35»')
    expect(exchange.request_headers['accept']).toBe('application/json')
    expect(exchange.request_body).toEqual({ password: '«redacted:string:14»', name: 'ada' })
    expect(JSON.stringify(exchange)).not.toContain('hunter2')
  })

  it('produces an exchange the shared schema accepts', () => {
    expect(() => Exchange.parse(finalize(draft(), ctx, 'x2'))).not.toThrow()
  })

  it('carries position, origin, and provenance through', () => {
    const exchange = finalize(draft({ started_at: 2_000 }), ctx, 'x3')
    expect(exchange.position).toBe(3)
    expect(exchange.origin).toBe('https://app.example')
    expect(exchange.background).toBe(false)
    expect(exchange.provenance?.accessible_name).toBe('Create order')
  })

  it('omits provenance and marks background outside the window', () => {
    const exchange = finalize(draft({ started_at: 90_000 }), ctx, 'x4')
    expect(exchange.background).toBe(true)
    expect(exchange.provenance).toBeUndefined()
  })
})

describe('Reconciler (T-002.6)', () => {
  it('emits a MAIN-world capture immediately', () => {
    const r = new Reconciler()
    expect(r.accept(draft(), 0)).toHaveLength(1)
  })

  it('drops an oracle capture of a request the interceptor already claimed', () => {
    const r = new Reconciler()
    r.accept(draft(), 0)
    expect(r.accept(draft({ source: 'web_request' }), 0)).toHaveLength(0)
    expect(r.due(RECONCILE_GRACE_MS + 1)).toHaveLength(0)
  })

  it('emits an oracle capture the interceptor never saw, once the grace window passes', () => {
    const r = new Reconciler()
    expect(r.accept(draft({ source: 'web_request' }), 0)).toHaveLength(0)
    expect(r.due(RECONCILE_GRACE_MS - 1)).toHaveLength(0)
    expect(r.due(RECONCILE_GRACE_MS + 1)).toHaveLength(1)
  })

  it('emits a webRequest-only observation as the coverage gap (AC-CAP-002.3)', () => {
    const r = new Reconciler()
    r.accept(draft({ source: 'web_request', body_missing: true, body_missing_reason: 'interceptor_miss' }), 0)
    const [emitted] = r.due(RECONCILE_GRACE_MS + 1)
    expect(emitted?.body_missing).toBe(true)
    expect(emitted?.body_missing_reason).toBe('interceptor_miss')
  })

  it('does not collapse two genuine calls to the same URL', () => {
    const r = new Reconciler()
    // Two MAIN-world emissions bank two credits, so both oracle drafts are accounted for.
    expect(r.accept(draft({ started_at: 1_000 }), 0)).toHaveLength(1)
    expect(r.accept(draft({ started_at: 1_500 }), 5)).toHaveLength(1)
    r.accept(draft({ source: 'web_request', started_at: 1_000 }), 6)
    r.accept(draft({ source: 'web_request', started_at: 1_500 }), 7)
    expect(r.due(RECONCILE_GRACE_MS + 10)).toHaveLength(0)
  })

  /**
   * AC-CAP-002.3 — the oracle observes a SUPERSET of MAIN-world traffic (service workers,
   * sendBeacon), so a URL can carry oracle-only traffic AND page traffic in one session. The
   * oracle-only exchange is the headers-only record the AC exists to guarantee, and it must
   * survive. This is the interleaving that a per-source ordinal scheme silently drops.
   */
  it('keeps an oracle-only exchange when the page later calls the same URL', () => {
    const r = new Reconciler()
    // The page's service worker fetches /api/orders — the interceptor cannot see it.
    r.accept(draft({ source: 'web_request', body_missing: true, body_missing_reason: 'interceptor_miss', started_at: 1_000 }), 0)
    // 200 ms later the page itself fetches the same URL, which the interceptor does see.
    expect(r.accept(draft({ started_at: 1_200 }), 200)).toHaveLength(1)

    const emitted = r.due(RECONCILE_GRACE_MS + 300)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.source).toBe('web_request')
    expect(emitted[0]?.body_missing).toBe(true)
  })

  it('suppresses an oracle draft the interceptor already captured', () => {
    const r = new Reconciler()
    // Same request seen by both paths: the body-bearing capture wins, once.
    // Both paths report the same start instant, give or take observation jitter.
    expect(r.accept(draft({ started_at: 1_000 }), 0)).toHaveLength(1)
    r.accept(draft({ source: 'web_request', body_missing: true, started_at: 1_004 }), 5)
    expect(r.due(RECONCILE_GRACE_MS + 10)).toHaveLength(0)
  })

  it('emits the second oracle capture when the interceptor only saw the first', () => {
    const r = new Reconciler()
    r.accept(draft({ started_at: 1_000 }), 0)
    r.accept(draft({ source: 'web_request', started_at: 1_000 }), 1)
    r.accept(draft({ source: 'web_request', started_at: 2_000 }), 2)
    expect(r.due(RECONCILE_GRACE_MS + 10)).toHaveLength(1)
  })

  it('flushes nothing twice', () => {
    const r = new Reconciler()
    r.accept(draft({ source: 'web_request' }), 0)
    expect(r.due(RECONCILE_GRACE_MS + 1)).toHaveLength(1)
    expect(r.due(RECONCILE_GRACE_MS + 2)).toHaveLength(0)
    expect(r.pending).toBe(0)
  })
})
