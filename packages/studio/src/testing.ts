import type { Exchange } from '@douze/shared'

/** Test support: a valid `Exchange` from the handful of fields a given case actually cares about. */
export interface ExchangeDraft {
  method?: string
  url: string
  status?: number
  request_body?: unknown
  response_body?: unknown
  request_headers?: Record<string, string>
  position?: number
  provenance?: string
  route?: string
  background?: boolean
}

let counter = 0

export function makeExchange(draft: ExchangeDraft): Exchange {
  const url = new URL(draft.url, 'https://app.example.com')
  const position = draft.position ?? counter
  counter = position + 1
  return {
    id: `ex-${position}-${url.pathname}`,
    session_id: 'test-session',
    position,
    started_at: Date.parse('2026-07-14T12:00:00Z') + position * 1000,
    duration_ms: 10,
    method: draft.method ?? 'GET',
    url: url.toString(),
    origin: url.origin,
    request_headers: draft.request_headers ?? { 'content-type': 'application/json' },
    ...(draft.request_body !== undefined ? { request_body: draft.request_body } : {}),
    status: draft.status ?? 200,
    response_headers: { 'content-type': 'application/json' },
    ...(draft.response_body !== undefined ? { response_body: draft.response_body } : {}),
    response_content_type: 'application/json',
    body_missing: false,
    background: draft.background ?? false,
    ...(draft.provenance !== undefined
      ? {
          provenance: {
            accessible_name: draft.provenance,
            role: 'button',
            route: draft.route ?? '/',
            title: 'Test app',
          },
        }
      : {}),
    source: 'main_world' as const,
  }
}

export function makeExchanges(drafts: ExchangeDraft[]): Exchange[] {
  counter = 0
  return drafts.map((draft, index) => makeExchange({ ...draft, position: draft.position ?? index }))
}

/** A GraphQL POST body in the shape the transport actually sends. */
export const graphqlBody = (query: string, variables: Record<string, unknown>, operationName?: string) => ({
  query,
  variables,
  ...(operationName !== undefined ? { operationName } : {}),
})
