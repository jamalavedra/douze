import type { Exchange } from '@douze/shared'

/**
 * The Endpoint Template parameter a page-supplied path credential fills. One name, because a
 * recipe targets one API and its project/tenant key appears in every path that carries one.
 * Defined here rather than in `api.ts` to keep this module a leaf: `api → engine → templating`.
 */
export const PATH_CREDENTIAL_PARAM = 'project_key'

/**
 * REQ-INF-001 — requests that differ only by identifier collapse into one Endpoint Template,
 * so a session with forty order pages yields `get_order`, not forty tools.
 */
export interface EndpointGroup {
  method: string
  /** Endpoint Template with `{param}` segments, e.g. `/orders/{orderId}`. */
  path: string
  /** Path parameter names, in segment order. */
  params: string[]
  exchanges: Exchange[]
}

export function pathSegments(url: string): string[] {
  const pathname = new URL(url).pathname
  const segments = pathname.split('/').filter((s) => s.length > 0)
  // A trailing slash is part of the route: `/search/` and `/search` are two URLs to a server, and
  // the one it does not serve answers 404 or redirects — which replay refuses to follow. Kept as
  // an empty last segment, so it survives templating and can never read as an identifier.
  if (segments.length > 0 && pathname.endsWith('/')) segments.push('')
  return segments
}

export function queryParams(url: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of new URL(url).searchParams) out[key] = value
  return out
}

interface Cluster {
  method: string
  segments: string[]
  /** Segment index that varies across members; null while every member is identical. */
  varying: number | null
  exchanges: Exchange[]
}

/**
 * AC-INF-001.1 — two exchanges merge only when they share a method and differ in exactly one
 * segment, and a cluster only ever varies at one position. That keeps `/a/1` + `/a/2` + `/b/2`
 * from collapsing transitively into a template with two holes.
 */
export function groupEndpoints(exchanges: Exchange[]): EndpointGroup[] {
  const clusters: Cluster[] = []
  for (const exchange of exchanges) {
    const method = exchange.method.toUpperCase()
    const segments = pathSegments(exchange.url)
    const cluster = clusters.find((c) => absorbs(c, method, segments))
    if (!cluster) {
      clusters.push({ method, segments, varying: null, exchanges: [exchange] })
      continue
    }
    const diff = firstDifference(cluster.segments, segments)
    if (diff !== null) cluster.varying = diff
    cluster.exchanges.push(exchange)
  }
  return clusters.map(toGroup).sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`))
}

function absorbs(cluster: Cluster, method: string, segments: string[]): boolean {
  if (cluster.method !== method || cluster.segments.length !== segments.length) return false
  const differing = cluster.segments.flatMap((seg, i) => (seg === segments[i] ? [] : [i]))
  if (differing.length === 0) return true
  if (differing.length > 1) return false
  const index = differing[0] as number
  // A differing segment is only a parameter if it reads as an identifier. Without this,
  // `/orders/1042/refund` and `/orders/1042/cancel` differ in one segment and would collapse
  // into `/orders/1042/{action}` — two distinct operations fused into one useless tool.
  if (!looksIdentifier(cluster.segments[index]) || !looksIdentifier(segments[index])) return false
  return cluster.varying === null || cluster.varying === index
}

/** Digits or a UUID prefix: enough to separate `1042` and `9f3a-…` from `refund`. */
const looksIdentifier = (value: string | undefined): boolean =>
  value !== undefined && (/\d/.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(value))

function firstDifference(a: string[], b: string[]): number | null {
  const index = a.findIndex((seg, i) => seg !== b[i])
  return index === -1 ? null : index
}

function toGroup(cluster: Cluster): EndpointGroup {
  const varying = cluster.varying ?? soleObservationParameter(cluster)
  if (varying === null) {
    return { ...templated(cluster.segments), method: cluster.method, exchanges: cluster.exchanges }
  }
  const name = nameParameter(cluster, varying)
  const segments = cluster.segments.map((seg, i) => (i === varying ? `{${name}}` : seg))
  // `templated` returns no params by design — the path credential it inserts is filled by the
  // page, not the caller, so it stays out of the input schema.
  return {
    method: cluster.method,
    path: templated(segments).path,
    params: [name],
    exchanges: cluster.exchanges,
  }
}

/**
 * A redacted segment is not an address. A project key in the path is a credential by shape, so
 * redaction replaced it — and a recipe carrying `/v1/project/apikey/«redacted:string:44»/origins`
 * called a URL that exists nowhere, which the API answered "Invalid API key format".
 *
 * It becomes a parameter the PAGE fills at call time (see `authFrom` and the relay's
 * `credentialContributions`), not one the caller supplies: an agent cannot know a project's key.
 * The parameter is deliberately left out of `params`, which is what feeds the input schema.
 */
function templated(segments: string[]): { path: string; params: string[] } {
  const replaced = segments.map((segment) => (isRedacted(segment) ? `{${PATH_CREDENTIAL_PARAM}}` : segment))
  return { path: `/${replaced.join('/')}`, params: [] }
}

/** The placeholder as it survives a round trip through `new URL()`, which percent-encodes it. */
const isRedacted = (segment: string): boolean =>
  segment.includes('«redacted:') || segment.includes('%C2%ABredacted')

/**
 * A single-observation endpoint has nothing to diff against, so `POST /orders/1044/cancel` would
 * become a tool that can only ever cancel order 1044. When the segment reads as an identifier
 * *and* the response echoes it back as an id field, that is evidence enough to parameterise it —
 * the same evidence AC-INF-001.2 uses for naming. Confidence stays capped at 0.4 either way.
 */
function soleObservationParameter(cluster: Cluster): number | null {
  for (let index = cluster.segments.length - 1; index >= 0; index -= 1) {
    const segment = cluster.segments[index]
    if (!looksIdentifier(segment) || segment === undefined) continue
    if (cluster.exchanges.some((e) => findIdField(e.response_body, segment) !== null)) return index
  }
  return null
}

/**
 * AC-INF-001.2 — prefer a name taken from an `id`-like response field whose value is the segment.
 * AC-INF-001.3 — otherwise fall back to the preceding static segment, singularised.
 */
function nameParameter(cluster: Cluster, index: number): string {
  const preceding = index > 0 ? (cluster.segments[index - 1] ?? 'resource') : 'resource'
  for (const exchange of cluster.exchanges) {
    const value = pathSegments(exchange.url)[index]
    if (value === undefined) continue
    const field = findIdField(exchange.response_body, value)
    if (field !== null) return qualify(field, preceding)
  }
  return camel(singular(preceding))
}

/** Walks a response body for a key ending in `id` whose value is the observed path segment. */
function findIdField(body: unknown, value: string, depth = 0): string | null {
  if (depth > 3 || body === null || typeof body !== 'object') return null
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = findIdField(item, value, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  for (const [key, nested] of Object.entries(body)) {
    if (/(^|_)id$|Id$/.test(key) && String(nested) === value) return key
  }
  for (const nested of Object.values(body)) {
    const found = findIdField(nested, value, depth + 1)
    if (found !== null) return found
  }
  return null
}

/** A bare `id` field is ambiguous across a recipe, so qualify it with its resource. */
function qualify(field: string, preceding: string): string {
  return field.toLowerCase() === 'id' ? `${camel(singular(preceding))}Id` : camel(field)
}

/** `/orders/{orderId}` addresses one record; `/orders/{orderId}/shipments` addresses a collection. */
export const addressesOneRecord = (path: string): boolean => /\{[^}]+\}$/.test(path)

export function singular(word: string): string {
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`
  if (/(s|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2)
  if (/ss$/i.test(word)) return word
  if (/s$/i.test(word)) return word.slice(0, -1)
  return word
}

export function plural(word: string): string {
  if (/s$/i.test(word)) return word
  if (/(x|z|ch|sh)$/i.test(word)) return `${word}es`
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`
  return `${word}s`
}

export function camel(word: string): string {
  const parts = word.split(/[-_\s]+/).filter(Boolean)
  const [head = '', ...rest] = parts
  return head.toLowerCase() + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('')
}

export function snake(word: string): string {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}
