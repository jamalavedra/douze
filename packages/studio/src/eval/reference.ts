import type { AnnotationSpan, Exchange, UiProvenance } from '@recon/shared'
import { infer } from '../inference/engine.js'
import type { Candidate } from '../types.js'

/**
 * The reference "orders" session: a small merchant dashboard, recorded the way a user would drive
 * it. It backs the selection-accuracy eval (COV_INF_006.3) and doubles as a realistic end-to-end
 * fixture for the inference and review tests.
 */

const ORIGIN = 'https://shop.example.com'
let clock = Date.parse('2026-07-14T10:00:00Z')
let position = 0

interface Draft {
  method: string
  path: string
  status?: number
  request_body?: unknown
  response_body?: unknown
  provenance?: string
  route?: string
  background?: boolean
}

function exchange(draft: Draft): Exchange {
  clock += 1_500
  const provenance: UiProvenance | undefined =
    draft.provenance === undefined
      ? undefined
      : { accessible_name: draft.provenance, role: 'button', route: draft.route ?? '/orders', title: 'Shop admin' }
  return {
    id: `ex-${position}`,
    session_id: 'reference-orders',
    position: position++,
    started_at: clock,
    duration_ms: 42,
    method: draft.method,
    url: `${ORIGIN}${draft.path}`,
    origin: ORIGIN,
    request_headers: { 'content-type': 'application/json', authorization: '«redacted:string:187»' },
    ...(draft.request_body !== undefined ? { request_body: draft.request_body } : {}),
    status: draft.status ?? 200,
    response_headers: { 'content-type': 'application/json' },
    ...(draft.response_body !== undefined ? { response_body: draft.response_body } : {}),
    response_content_type: 'application/json',
    body_missing: false,
    background: draft.background ?? false,
    ...(provenance !== undefined ? { provenance } : {}),
    source: 'main_world',
  }
}

const order = (id: number, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  customer_id: 88,
  status,
  currency: 'usd',
  total_cents: 12_900,
  placed_at: '2026-07-01T09:12:00Z',
  ...extra,
})

const customer = (id: number, email: string) => ({
  id,
  email,
  name: 'Ada Lovelace',
  created_at: '2025-02-02T08:00:00Z',
  lifetime_value_cents: 91_000,
})

export function referenceExchanges(): Exchange[] {
  clock = Date.parse('2026-07-14T10:00:00Z')
  position = 0
  return [
    exchange({
      method: 'GET',
      path: '/api/orders?page=1&status=open',
      response_body: { data: [order(1042, 'open'), order(1043, 'shipped')], page: 1, total: 2 },
      provenance: 'Orders',
      route: '/orders',
    }),
    exchange({
      method: 'GET',
      path: '/api/orders?page=2&status=open',
      response_body: { data: [order(1044, 'open')], page: 2, total: 2 },
      background: true,
    }),
    exchange({
      method: 'GET',
      path: '/api/orders?page=1&status=refunded',
      response_body: { data: [order(1030, 'refunded')], page: 1, total: 1 },
      provenance: 'Refunded',
      route: '/orders',
    }),
    exchange({ method: 'GET', path: '/api/orders/1042', response_body: { data: order(1042, 'open') }, provenance: 'Order 1042', route: '/orders/1042' }),
    exchange({ method: 'GET', path: '/api/orders/1043', response_body: { data: order(1043, 'shipped') } }),
    exchange({ method: 'GET', path: '/api/orders/1044', response_body: { data: order(1044, 'open', { note: 'gift wrap' }) } }),
    exchange({
      method: 'POST',
      path: '/api/orders',
      request_body: { customer_id: 88, currency: 'usd', items: [{ sku: 'TEA-01', quantity: 2 }] },
      status: 201,
      response_body: { data: order(1045, 'open') },
      provenance: 'Create order',
      route: '/orders/new',
    }),
    exchange({
      method: 'POST',
      path: '/api/orders',
      request_body: { customer_id: 91, currency: 'eur', items: [{ sku: 'MUG-04', quantity: 1 }], note: 'ship fast' },
      status: 201,
      response_body: { data: order(1046, 'open') },
      provenance: 'Create order',
      route: '/orders/new',
    }),
    exchange({
      method: 'POST',
      path: '/api/orders',
      request_body: { customer_id: 88, currency: 'usd', items: [{ sku: 'TEA-01', quantity: 5 }] },
      status: 201,
      response_body: { data: order(1047, 'open') },
      provenance: 'Create order',
      route: '/orders/new',
    }),
    exchange({
      method: 'PATCH',
      path: '/api/orders/1042',
      request_body: { status: 'shipped', tracking_number: 'TRK-99' },
      response_body: { data: order(1042, 'shipped') },
      provenance: 'Save',
      route: '/orders/1042',
    }),
    exchange({
      method: 'PATCH',
      path: '/api/orders/1043',
      request_body: { status: 'delivered', tracking_number: 'TRK-12' },
      response_body: { data: order(1043, 'delivered') },
      provenance: 'Save',
      route: '/orders/1043',
    }),
    exchange({
      method: 'POST',
      path: '/api/orders/1030/refund',
      request_body: { amount_cents: 12_900, reason: 'damaged' },
      response_body: { data: { refund_id: 'rf_7', order_id: 1030, amount_cents: 12_900, state: 'succeeded' } },
      provenance: 'Issue refund',
      route: '/orders/1030',
    }),
    exchange({
      method: 'POST',
      path: '/api/orders/1031/refund',
      request_body: { amount_cents: 4_500, reason: 'late delivery' },
      response_body: { data: { refund_id: 'rf_8', order_id: 1031, amount_cents: 4_500, state: 'succeeded' } },
      provenance: 'Issue refund',
      route: '/orders/1031',
    }),
    exchange({
      method: 'POST',
      path: '/api/orders/1044/cancel',
      request_body: { reason: 'customer changed their mind' },
      response_body: { data: order(1044, 'cancelled') },
      provenance: 'Cancel order',
      route: '/orders/1044',
    }),
    exchange({
      method: 'GET',
      path: '/api/customers',
      response_body: { data: [customer(88, 'ada@example.com'), customer(91, 'grace@example.com')], page: 1 },
      provenance: 'Customers',
      route: '/customers',
    }),
    exchange({
      method: 'GET',
      path: '/api/customers?page=2',
      response_body: { data: [customer(92, 'alan@example.com')], page: 2 },
      background: true,
    }),
    exchange({ method: 'GET', path: '/api/customers/88', response_body: { data: customer(88, 'ada@example.com') }, provenance: 'Ada Lovelace', route: '/customers/88' }),
    exchange({ method: 'GET', path: '/api/customers/91', response_body: { data: customer(91, 'grace@example.com') } }),
    exchange({
      method: 'GET',
      path: '/api/products',
      response_body: { data: [{ sku: 'TEA-01', title: 'Loose leaf tea', price_cents: 1_400, stock: 12 }], page: 1 },
      provenance: 'Products',
      route: '/products',
    }),
    exchange({
      method: 'GET',
      path: '/api/products?page=2',
      response_body: { data: [{ sku: 'MUG-04', title: 'Stoneware mug', price_cents: 2_200, stock: 3 }], page: 2 },
      background: true,
    }),
    exchange({
      method: 'GET',
      path: '/api/orders/1042/shipments',
      response_body: { data: [{ id: 'sh_1', carrier: 'DHL', tracking_number: 'TRK-99', state: 'in_transit' }] },
      provenance: 'Shipments',
      route: '/orders/1042',
    }),
    exchange({
      method: 'GET',
      path: '/api/orders/1043/shipments',
      response_body: { data: [{ id: 'sh_2', carrier: 'UPS', tracking_number: 'TRK-12', state: 'delivered' }] },
    }),
  ]
}

/** Notes the way a user actually types them mid-recording, covering the write operations. */
export function referenceAnnotations(): AnnotationSpan[] {
  return [
    {
      id: 'span-1',
      session_id: 'reference-orders',
      note: 'marks an order as shipped and attaches its tracking number',
      start_position: 9,
      end_position: 10,
    },
    {
      id: 'span-2',
      session_id: 'reference-orders',
      note: 'refunds money back to the shopper for a bad order',
      start_position: 11,
      end_position: 12,
    },
    {
      id: 'span-3',
      session_id: 'reference-orders',
      note: 'calls off an order the shopper no longer wants before it ships',
      start_position: 13,
      end_position: 13,
    },
  ]
}

export function referenceCandidates(): Candidate[] {
  return infer({ exchanges: referenceExchanges(), annotations: referenceAnnotations() })
}
