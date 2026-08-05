import { describe, expect, it } from 'vitest'
import { Exchange, NOISE_HOSTS } from '@recon/shared'
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
  const origins = ['https://app.example']

  it('keeps a JSON exchange on the recorded origin', () => {
    expect(admits(draft(), origins)).toBe(true)
  })

  it('drops a third-party analytics request (AC-CAP-004.1)', () => {
    expect(admits(draft({ url: 'https://www.google-analytics.com/collect' }), origins)).toBe(false)
  })

  it('drops a CSS asset (AC-CAP-004.2)', () => {
    const css = draft({ url: 'https://app.example/app.css', response_content_type: 'text/css' })
    expect(admits(css, origins)).toBe(false)
  })

  it('drops an exchange from an origin the session does not cover (AC-CAP-001.1)', () => {
    expect(admits(draft({ url: 'https://other.example/api/orders' }), origins)).toBe(false)
  })

  it('honours a user addition to the noise list (AC-CAP-004.3)', () => {
    const beacon = draft({ url: 'https://app.example/metrics/collect' })
    expect(admits(beacon, origins)).toBe(true)
    expect(admits(beacon, origins, { hosts: [...NOISE_HOSTS, 'app.example'] })).toBe(false)
  })
})

describe('finalize', () => {
  const ctx = { session_id: 's1', position: 3, gesture: gesture(999) }

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

  it('drops a debugger capture of a request the interceptor already claimed', () => {
    const r = new Reconciler()
    r.accept(draft(), 0)
    expect(r.accept(draft({ source: 'debugger' }), 0)).toHaveLength(0)
    expect(r.due(RECONCILE_GRACE_MS + 1)).toHaveLength(0)
  })

  it('emits a debugger capture the interceptor never saw, once the grace window passes', () => {
    const r = new Reconciler()
    expect(r.accept(draft({ source: 'debugger' }), 0)).toHaveLength(0)
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
    r.accept(draft(), 0)
    r.accept(draft(), 5)
    r.accept(draft({ source: 'debugger' }), 6)
    r.accept(draft({ source: 'debugger' }), 7)
    expect(r.due(RECONCILE_GRACE_MS + 10)).toHaveLength(0)
  })

  it('emits the second debugger capture when the interceptor only saw the first', () => {
    const r = new Reconciler()
    r.accept(draft(), 0)
    r.accept(draft({ source: 'debugger' }), 1)
    r.accept(draft({ source: 'debugger' }), 2)
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
