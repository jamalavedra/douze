import type { ResponseContract } from '@douze/shared'
import type { JsonSchema } from '../types.js'

/** `Pagination` is exported from @douze/shared as a Zod schema value, not a type. */
type Pagination = NonNullable<ResponseContract['pagination']>

/**
 * AC-INF-005.1 — envelope keys carry no information, so the Primary Payload Path descends past
 * them to the subtree a tool result should actually contain.
 */
const ENVELOPE_KEYS = ['data', 'result', 'results', 'items', 'records', 'payload', 'nodes', 'edges', 'content', 'body']

/** AC-INF-005.3 — the escape hatch back to the untrimmed body. */
export const RAW_PARAM = {
  type: 'boolean',
  description: 'Return the full untrimmed response body instead of the primary payload.',
} as const

/**
 * Returns the JSONPath into the useful subtree, or `$` when the body is already the payload.
 * The path is the longest one that holds for every observed body, so a tool never trims into a
 * subtree that only some responses have.
 */
export function primaryPayloadPath(bodies: readonly unknown[]): string {
  const paths = bodies.filter((b) => b !== undefined && b !== null).map(descend)
  if (paths.length === 0) return '$'
  return paths.reduce(commonPrefix)
}

function descend(body: unknown): string {
  let node = body
  const segments: string[] = []
  while (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const record = node as Record<string, unknown>
    const keys = Object.keys(record)
    const envelope = ENVELOPE_KEYS.find((k) => keys.includes(k) && isContainer(record[k]))
    const only = keys.length === 1 && keys[0] !== undefined && isContainer(record[keys[0]]) ? keys[0] : undefined
    const next = envelope ?? only
    if (next === undefined) break
    segments.push(next)
    node = record[next]
  }
  return segments.length === 0 ? '$' : `$.${segments.join('.')}`
}

const isContainer = (value: unknown): boolean => value !== null && typeof value === 'object'

function commonPrefix(a: string, b: string): string {
  const left = a.split('.')
  const right = b.split('.')
  const shared: string[] = []
  for (const [i, segment] of left.entries()) {
    if (segment !== right[i]) break
    shared.push(segment)
  }
  return shared.length === 0 ? '$' : shared.join('.')
}

/** Resolves a JSONPath produced by `primaryPayloadPath` (dotted keys only, no wildcards). */
export function resolvePath(body: unknown, path: string): unknown {
  if (path === '$') return body
  let node = body
  for (const key of path.split('.').slice(1)) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

const CURSOR_PARAMS = ['cursor', 'after', 'starting_after', 'page_token', 'next_cursor']
const OFFSET_PARAMS = ['offset', 'skip', 'start']
const PAGE_PARAMS = ['page', 'page_number', 'pageNumber']
const NEXT_KEYS = ['next_cursor', 'nextCursor', 'end_cursor', 'endCursor', 'next', 'next_page']

/**
 * AC-INF-005.2 — a paginated collection exposes its page or cursor parameter and records the
 * style, so the runtime can drive the next page instead of returning a truncated first one.
 */
export function detectPagination(
  observedQuery: readonly Record<string, string>[],
  bodies: readonly unknown[],
): Pagination | undefined {
  const seen = new Set(observedQuery.flatMap((q) => Object.keys(q)))
  const nextPath = findNextPath(bodies)
  const match = (candidates: string[]): string | undefined => candidates.find((c) => seen.has(c))

  const cursor = match(CURSOR_PARAMS)
  if (cursor !== undefined) {
    return { style: 'cursor', param: cursor, ...(nextPath !== undefined ? { next_path: nextPath } : {}) }
  }
  const offset = match(OFFSET_PARAMS)
  if (offset !== undefined) return { style: 'offset', param: offset }
  const page = match(PAGE_PARAMS)
  if (page !== undefined) return { style: 'page', param: page }
  return undefined
}

function findNextPath(bodies: readonly unknown[], node: unknown = bodies[0], path = '$', depth = 0): string | undefined {
  if (depth > 3 || node === null || typeof node !== 'object' || Array.isArray(node)) return undefined
  const record = node as Record<string, unknown>
  for (const key of NEXT_KEYS) {
    if (key in record) return `${path}.${key}`
  }
  for (const [key, value] of Object.entries(record)) {
    const found = findNextPath(bodies, value, `${path}.${key}`, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** Adds the `raw` escape hatch to an input schema without disturbing its required set. */
export function withRawParam(schema: JsonSchema): JsonSchema {
  const properties = { ...(schema['properties'] as Record<string, unknown> | undefined), raw: RAW_PARAM }
  return { ...schema, type: 'object', properties }
}
