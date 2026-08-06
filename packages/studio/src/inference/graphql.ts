import type { Exchange } from '@douze/shared'

/**
 * REQ-INF-004 — a single `/graphql` endpoint would otherwise collapse into one useless tool,
 * so exchanges are grouped by operation name and each operation becomes its own candidate.
 */
export interface GraphqlOperation {
  /** Operation name as observed, or derived from the root field (AC-INF-004.3). */
  operation: string
  document: string
  kind: 'query' | 'mutation'
  /** AC-INF-004.3 — the operation was anonymous and this name came from its root field. */
  derived_name: boolean
  /** Path of the GraphQL endpoint, e.g. `/graphql`. */
  path: string
  /** Every exchange for this operation, successful or not. */
  exchanges: Exchange[]
  /** AC-INF-004.4 — HTTP 200 carrying a populated `errors` array. Excluded from the contract. */
  failed: Exchange[]
}

interface GraphqlBody {
  query: string
  variables: Record<string, unknown>
  operationName?: string
}

function readBody(value: unknown): GraphqlBody | null {
  let body = value
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return null
    }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (typeof record['query'] !== 'string') return null
  const variables = record['variables']
  const name = record['operationName']
  return {
    query: record['query'],
    variables: variables !== null && typeof variables === 'object' ? (variables as Record<string, unknown>) : {},
    ...(typeof name === 'string' && name.length > 0 ? { operationName: name } : {}),
  }
}

export function isGraphqlExchange(exchange: Exchange): boolean {
  return readBody(exchange.request_body) !== null
}

/** AC-INF-004.4 — a 200 with errors is a failed exchange, not a successful contract sample. */
export function hasGraphqlErrors(exchange: Exchange): boolean {
  const body = exchange.response_body
  if (body === null || typeof body !== 'object') return false
  const errors = (body as Record<string, unknown>)['errors']
  return Array.isArray(errors) && errors.length > 0
}

export function graphqlVariables(exchange: Exchange): Record<string, unknown> {
  return readBody(exchange.request_body)?.variables ?? {}
}

/** AC-INF-004.1 — one group, and therefore one candidate, per operation name. */
export function splitOperations(exchanges: Exchange[]): GraphqlOperation[] {
  const groups = new Map<string, GraphqlOperation>()
  for (const exchange of exchanges) {
    const body = readBody(exchange.request_body)
    if (!body) continue
    const identity = identify(body)
    if (!identity) continue
    const key = identity.operation
    let group = groups.get(key)
    if (!group) {
      group = {
        operation: identity.operation,
        document: body.query,
        kind: identity.kind,
        derived_name: identity.derived_name,
        path: new URL(exchange.url).pathname,
        exchanges: [],
        failed: [],
      }
      groups.set(key, group)
    }
    group.exchanges.push(exchange)
    if (hasGraphqlErrors(exchange)) group.failed.push(exchange)
  }
  return [...groups.values()].sort((a, b) => a.operation.localeCompare(b.operation))
}

const NAMED = /\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/
const ANONYMOUS_ROOT = /\{\s*([A-Za-z_][A-Za-z0-9_]*)/

function identify(body: GraphqlBody): { operation: string; kind: 'query' | 'mutation'; derived_name: boolean } | null {
  const named = NAMED.exec(body.query)
  const kind: 'query' | 'mutation' = named?.[1] === 'mutation' || /^\s*mutation\b/.test(body.query) ? 'mutation' : 'query'
  if (body.operationName !== undefined) return { operation: body.operationName, kind, derived_name: false }
  if (named?.[2] !== undefined) return { operation: named[2], kind, derived_name: false }
  // AC-INF-004.3 — anonymous: the root field is the only evidence of what this operation is.
  const root = ANONYMOUS_ROOT.exec(body.query)
  if (root?.[1] === undefined) return null
  return { operation: root[1], kind, derived_name: true }
}
