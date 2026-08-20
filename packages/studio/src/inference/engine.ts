import {
  TOOL_METHODS,
  Tool,
  isDocumentSnapshot,
  isHtmlContentType,
  isPlaceholder,
  type AnnotationSpan,
  type Exchange,
  type UiProvenance,
} from '@douze/shared'
import type { Candidate, JsonSchema } from '../types.js'
import { describeSync, descriptionInput } from '../descriptions/writer.js'
import { disambiguate, nameCandidate } from '../descriptions/naming.js'
import { score } from './confidence.js'
import { graphqlVariables, hasGraphqlErrors, isGraphqlExchange, splitOperations } from './graphql.js'
import { detectPagination, primaryPayloadPath, resolvePath, withRawParam } from './payload.js'
import { coerceNumericValues, inferSchema, mergeSchemas, stability } from './schema.js'
import { classify } from './side-effects.js'
import { addressesOneRecord, groupEndpoints, queryParams, type EndpointGroup } from './templating.js'

export interface InferenceInput {
  exchanges: Exchange[]
  /** REQ-CAP-007 — spans are optional; a session without notes still produces candidates. */
  annotations?: AnnotationSpan[]
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * #InferenceEngine — exchanges to scored candidates. Deterministic and replayable: no model call
 * happens here, so re-inferring the same session always produces the same candidates (ADR-006).
 */
export function infer(input: InferenceInput): Candidate[] {
  const spans = input.annotations ?? []
  // A method no recipe can describe is skipped, not carried into `restCandidate` where the schema
  // throws and takes every other candidate down with it — a stored `OPTIONS` preflight did exactly
  // that. The store outlives the filter that no longer writes those.
  const usable = input.exchanges.filter(
    (e) => e.status > 0 && e.status < 400 && (TOOL_METHODS as readonly string[]).includes(e.method.toUpperCase()),
  )
  const graphql = usable.filter(isGraphqlExchange)
  const rest = usable.filter((e) => !isGraphqlExchange(e))
  // REQ-INF-006 — a page and an API answering the same path are two operations with nothing in
  // common but their URL. Grouping them apart is what keeps a snapshot out of a JSON tool's schema.
  const documents = rest.filter(isDocumentExchange)
  const json = rest.filter((e) => !isDocumentExchange(e))

  const candidates = [
    ...groupEndpoints(json).map((group) => restCandidate(group, spans)),
    ...groupEndpoints(documents).map((group) => restCandidate(group, spans, true)),
    ...splitOperations(graphql).map((op) => graphqlCandidate(op, spans)),
  ]

  // AC-INF-006.3 — collisions are resolved across the whole recipe, not per protocol.
  const names = disambiguate(
    candidates.map((c) => ({ name: c.tool.name, parameters: parameterNames(c.tool.request.input_schema) })),
  )
  for (const [index, candidate] of candidates.entries()) {
    const name = names[index]
    if (name !== undefined) candidate.tool.name = name
  }
  return candidates.sort((a, b) => a.tool.name.localeCompare(b.tool.name))
}

/**
 * REQ-INF-006 — a document exchange carries a `{ url, title, text, links }` snapshot the capture
 * pipeline extracted from an HTML reply, in place of the HTML itself.
 */
export const isDocumentExchange = (e: Exchange): boolean =>
  isHtmlContentType(e.response_content_type) && isDocumentSnapshot(e.response_body)

function restCandidate(group: EndpointGroup, spans: AnnotationSpan[], isDocument = false): Candidate {
  const { method, path, params, exchanges } = group
  const queries = exchanges.map((e) => queryParams(e.url))
  // A query value is a string in the URL and a number in the schema when it plainly is one,
  // which is what gives `limit` a ceiling at all.
  const coerced = queries.map(coerceNumericValues)
  const bodies = BODY_METHODS.has(method) ? exchanges.map((e) => e.request_body) : []
  const responses = exchanges.map((e) => e.response_body)

  // A snapshot is the whole result — there is no envelope to descend past and no page to fetch
  // next, so a `?page=2` in the URL is just another query parameter the caller supplies.
  const pagination = isDocument ? undefined : detectPagination(queries, responses)
  const inputSchema = withRawParam(
    // The pagination parameter is driven by the runtime, so it is never required of the caller
    // even when every observation happened to carry it (AC-INF-005.2).
    optional(
      mergeSchemas(
        pathParamSchema(params),
        siteDefaults(inferSchema(coerced), coerced, pagination?.param),
        inferSchema(bodies),
      ),
      pagination?.param,
    ),
  )
  const payloadPath = isDocument ? '$' : primaryPayloadPath(responses)
  const outputSchema = inferSchema(responses.map((body) => resolvePath(body, payloadPath)))
  const sideEffect = classify({ method, path })
  const annotation = noteFor(exchanges, spans)
  const provenance = provenanceFor(exchanges)

  const name = nameCandidate({
    method,
    path,
    sideEffect,
    addressed: addressesOneRecord(path),
    annotation,
    provenance: provenance?.accessible_name,
  })

  return assemble({
    name,
    sideEffect,
    exchanges,
    annotation,
    provenance,
    request: { method, path, input_schema: inputSchema },
    payloadPath,
    outputSchema,
    pagination,
    stabilityScore: (stability(inputSchema) + stability(outputSchema)) / 2,
  })
}

function optional(schema: JsonSchema, key: string | undefined): JsonSchema {
  if (key === undefined) return schema
  const required = ((schema['required'] as string[] | undefined) ?? []).filter((k) => k !== key)
  return required.length > 0 ? { ...schema, required } : omitRequired(schema)
}

function omitRequired(schema: JsonSchema): JsonSchema {
  const { required: _required, ...rest } = schema
  return rest
}

/**
 * A query parameter whose value never varied is the site decorating its own URLs, not something a
 * caller could know to send: reddit's search carries `screen_view_count=1&ext-referrer=DIRECT` and
 * wikipedia's `title=Special:Search`. Inference made every observed parameter required, so both
 * tools refused `{q: 'ledger'}` / `{search: 'Ledger'}` until the caller reproduced the site's own
 * decorations. Such a parameter stays in the schema so a caller may still override it, but it is
 * optional and carries the observed value as a `default` that `buildRequest` sends when the caller
 * omits it.
 *
 * One observation counts as "never varied" deliberately — a tool recorded once is the common case
 * and the one this blocks. Two observations disagreeing about a value make it a caller input again.
 */
function siteDefaults(
  schema: JsonSchema,
  queries: readonly Record<string, string | number>[],
  paginationParam: string | undefined,
): JsonSchema {
  const properties = schema['properties'] as Record<string, JsonSchema> | undefined
  if (properties === undefined) return schema
  const constant = new Set<string>()
  const withDefaults: Record<string, JsonSchema> = {}
  for (const [key, property] of Object.entries(properties)) {
    const values = queries.map((q) => q[key])
    const observed = values[0]
    // The pagination parameter is the runtime's to drive, so pinning it to the page the app
    // happened to be on would fight `detectPagination`. A redacted value is a placeholder rather
    // than anything the site sent: resending `«redacted:string:8»` is worse than omitting the
    // parameter, so it gets no default either.
    const fixed =
      key !== paginationParam &&
      observed !== undefined &&
      !isPlaceholder(observed) &&
      values.every((value) => value === observed)
    withDefaults[key] = fixed ? { ...property, default: observed } : property
    if (fixed) constant.add(key)
  }
  const required = ((schema['required'] as string[] | undefined) ?? []).filter((k) => !constant.has(k))
  const next: JsonSchema = { ...schema, properties: withDefaults }
  return required.length > 0 ? { ...next, required } : omitRequired(next)
}

function graphqlCandidate(op: ReturnType<typeof splitOperations>[number], spans: AnnotationSpan[]): Candidate {
  const { operation, document, path, exchanges } = op
  /**
   * AC-INF-004.4 — a 200 carrying `errors` is a FAILED exchange and contributes to no part of
   * schema inference, input included. A rejected call is precisely the one whose variables are
   * wrong: letting it through demotes every field it omitted to optional, so the tool would
   * advertise that an agent may reproduce the exact request the server refused.
   */
  const successful = exchanges.filter((e) => !hasGraphqlErrors(e))
  const contractSource = successful.length > 0 ? successful : []

  // AC-INF-004.2 — the input schema comes from the observed `variables` object.
  const inputSchema = withRawParam(inferSchema(contractSource.map(graphqlVariables)))
  const responses = contractSource.map((e) => e.response_body)
  const payloadPath = graphqlPayloadPath(responses)
  const outputSchema = inferSchema(responses.map((body) => resolvePath(body, payloadPath)))
  const sideEffect = classify({ method: op.kind === 'mutation' ? 'POST' : 'GET', path, operation })
  const annotation = noteFor(exchanges, spans)
  const provenance = provenanceFor(exchanges)

  return assemble({
    name: nameCandidate({
      method: 'POST',
      path,
      sideEffect,
      addressed: false,
      annotation,
      provenance: provenance?.accessible_name,
      graphqlOperation: operation,
    }),
    sideEffect,
    exchanges,
    annotation,
    provenance,
    request: { method: 'POST', path, input_schema: inputSchema, graphql: { operation, document } },
    payloadPath,
    outputSchema,
    pagination: undefined,
    stabilityScore: (stability(inputSchema) + stability(outputSchema)) / 2,
    derivedName: op.derived_name,
    // Failed exchanges were observed, but only the successful ones back the contract.
    contractObservations: successful.length,
  })
}

/** A GraphQL result always sits under `data.<rootField>`; the envelope walk finds it. */
function graphqlPayloadPath(responses: readonly unknown[]): string {
  return primaryPayloadPath(responses)
}

interface Assembly {
  name: string
  sideEffect: ReturnType<typeof classify>
  exchanges: Exchange[]
  annotation?: string | undefined
  provenance?: UiProvenance | undefined
  request: { method: string; path: string; input_schema: JsonSchema; graphql?: { operation: string; document: string } }
  payloadPath: string
  outputSchema: JsonSchema
  pagination: ReturnType<typeof detectPagination>
  stabilityScore: number
  derivedName?: boolean
  contractObservations?: number
}

function assemble(a: Assembly): Candidate {
  const observations = a.contractObservations ?? a.exchanges.length
  const sample = a.exchanges[0]
  if (sample === undefined) throw new Error(`candidate "${a.name}" has no backing exchange`)

  const tool = Tool.parse({
    name: a.name,
    description: '',
    side_effect: a.sideEffect,
    confidence: score({ observations, stability: a.stabilityScore, sideEffect: a.sideEffect }),
    observations,
    approved: false,
    request: a.request,
    response: {
      ...(a.payloadPath !== '$' ? { primary_payload_path: a.payloadPath } : {}),
      output_schema: a.outputSchema,
      ...(a.pagination !== undefined ? { pagination: a.pagination } : {}),
    },
    ...(a.annotation !== undefined ? { annotation: a.annotation } : {}),
    flags: {
      // AC-INF-002.3 — one observation is not a contract.
      sparse: observations <= 1,
      derived_name: a.derivedName ?? false,
      last_observed: isoDate(Math.max(...a.exchanges.map((e) => e.started_at))),
    },
  })
  tool.description = describeSync(descriptionInput(tool, a.provenance?.accessible_name))

  return {
    tool,
    evidence: {
      exchange_ids: a.exchanges.map((e) => e.id),
      sample,
      ...(a.provenance !== undefined ? { provenance: a.provenance } : {}),
      ...(a.annotation !== undefined ? { annotation: a.annotation } : {}),
    },
  }
}

function pathParamSchema(params: string[]): JsonSchema {
  const properties: Record<string, unknown> = {}
  for (const param of params) properties[param] = { type: 'string', description: `Path parameter \`${param}\`.` }
  return params.length === 0 ? {} : { type: 'object', properties, required: [...params].sort() }
}

/**
 * AC-CAP-007.5 — a span that covers exchanges split across several candidates attaches to each
 * of them. AC-CAP-007.4 — a session without spans simply yields no notes.
 */
function noteFor(exchanges: Exchange[], spans: AnnotationSpan[]): string | undefined {
  const span = spans.find((s) =>
    exchanges.some((e) => e.position >= s.start_position && e.position <= s.end_position),
  )
  return span?.note
}

/** The provenance seen most often across the group; a one-off click should not name the tool. */
function provenanceFor(exchanges: Exchange[]): UiProvenance | undefined {
  const counts = new Map<string, { provenance: UiProvenance; count: number }>()
  for (const exchange of exchanges) {
    if (exchange.background || exchange.provenance === undefined) continue
    const key = exchange.provenance.accessible_name
    const entry = counts.get(key)
    if (entry) entry.count += 1
    else counts.set(key, { provenance: exchange.provenance, count: 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.provenance
}

function parameterNames(schema: JsonSchema): string[] {
  return Object.keys((schema['properties'] as Record<string, unknown> | undefined) ?? {}).filter((k) => k !== 'raw')
}

export function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}
