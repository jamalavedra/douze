import { Tool, type AnnotationSpan, type Exchange, type UiProvenance } from '@douze/shared'
import type { Candidate, JsonSchema } from '../types.js'
import { describeSync, descriptionInput } from '../descriptions/writer.js'
import { disambiguate, nameCandidate } from '../descriptions/naming.js'
import { score } from './confidence.js'
import { graphqlVariables, hasGraphqlErrors, isGraphqlExchange, splitOperations } from './graphql.js'
import { detectPagination, primaryPayloadPath, resolvePath, withRawParam } from './payload.js'
import { inferSchema, mergeSchemas, stability } from './schema.js'
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
  const usable = input.exchanges.filter((e) => e.status > 0 && e.status < 400)
  const graphql = usable.filter(isGraphqlExchange)
  const rest = usable.filter((e) => !isGraphqlExchange(e))

  const candidates = [
    ...groupEndpoints(rest).map((group) => restCandidate(group, spans)),
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

function restCandidate(group: EndpointGroup, spans: AnnotationSpan[]): Candidate {
  const { method, path, params, exchanges } = group
  const queries = exchanges.map((e) => queryParams(e.url))
  const bodies = BODY_METHODS.has(method) ? exchanges.map((e) => e.request_body) : []
  const responses = exchanges.map((e) => e.response_body)

  const pagination = detectPagination(queries, responses)
  const inputSchema = withRawParam(
    // The pagination parameter is driven by the runtime, so it is never required of the caller
    // even when every observation happened to carry it (AC-INF-005.2).
    optional(mergeSchemas(pathParamSchema(params), inferSchema(queries), inferSchema(bodies)), pagination?.param),
  )
  const payloadPath = primaryPayloadPath(responses)
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
