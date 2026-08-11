import { findSurvivingSecrets, redactBody, redactHeaders, type SideEffect, type Tool } from '@douze/shared'
import type { Candidate, JsonSchema } from '../types.js'
import { addressesOneRecord, plural, singular } from '../inference/templating.js'
import { objectFrom } from './naming.js'
import type { ModelClient } from './model-client.js'

/** AC-INF-006.2 — what it does, what it returns, when to use it. Never more than three. */
const MAX_SENTENCES = 3

/**
 * A hard character bound on a description, because the sentence limit is not one: `limitSentences`
 * splits on sentence terminators, so a note with none — or a model reply with none — is a single
 * unbounded "sentence" that survives it intact.
 *
 * The number is set by what happens downstream, not by taste. The attachment protocol caps a tool
 * description at 4096 characters and a host DROPS a frame that fails to parse, so one over-long
 * description costs the client the whole tool surface, silently. The extension also appends its own
 * text when it attaches (the destructive sentence, a degradation reason), so the bound has to leave
 * room for that: 1024 is several times any real description and a quarter of the frame's limit.
 */
export const MAX_DESCRIPTION_CHARS = 1024

export interface DescriptionInput {
  name: string
  method: string
  path: string
  sideEffect: SideEffect
  /** Resource noun the tool acts on, singular. */
  object: string
  /** True when the path addresses one record rather than a collection. */
  addressed: boolean
  primaryPayloadPath: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  paginated: boolean
  paginationParam?: string | undefined
  annotation?: string | undefined
  provenance?: string | undefined
  graphqlOperation?: string | undefined
}

export function descriptionInput(tool: Tool, provenance?: string | undefined): DescriptionInput {
  const path = tool.request.path
  const graphql = tool.request.graphql?.operation
  return {
    name: tool.name,
    method: tool.request.method,
    path,
    sideEffect: tool.side_effect,
    object: singular(objectNoun(tool.name, objectFrom(path), graphql)),
    addressed: addressesOneRecord(path),
    primaryPayloadPath: tool.response.primary_payload_path ?? '$',
    inputSchema: tool.request.input_schema,
    outputSchema: tool.response.output_schema,
    paginated: tool.response.pagination !== undefined,
    ...(tool.response.pagination !== undefined ? { paginationParam: tool.response.pagination.param } : {}),
    ...(tool.annotation !== undefined ? { annotation: tool.annotation } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(graphql !== undefined ? { graphqlOperation: graphql } : {}),
  }
}

/** For GraphQL the path is just `/graphql`, so the noun has to come from the tool name. */
function objectNoun(name: string, lastStatic: string | undefined, graphql: string | undefined): string {
  if (graphql !== undefined) return name.split('_').slice(1).join('_') || name
  return lastStatic ?? 'resource'
}

/**
 * #DescriptionWriter, deterministic path. Produces a selection-oriented description with no model
 * call, so inference stays replayable offline and a model is an enhancement rather than a
 * dependency (ADR-006).
 */
export function describeSync(input: DescriptionInput): string {
  return boundDescription([action(input), returns(input), usage(input)].join(' '))
}

/** Every description, from either path, leaves through here. Three sentences AND 1024 characters. */
export function boundDescription(text: string): string {
  const limited = limitSentences(text)
  if (limited.length <= MAX_DESCRIPTION_CHARS) return limited
  return `${limited.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`
}

/** AC-CAP-007.3 — the note describes intent; the button label only describes the control. */
function action(input: DescriptionInput): string {
  if (input.annotation !== undefined) return sentence(capitalize(input.annotation.trim()))
  const noun = input.object
  switch (input.sideEffect) {
    case 'read':
      return input.addressed
        ? sentence(`Fetches a single ${noun} by ${pathParams(input.path).join(' and ') || 'identifier'}`)
        : sentence(`Lists ${plural(noun)} from ${input.path}${filters(input)}`)
    case 'destructive':
      return sentence(`${capitalize(verbOf(input.name))}s ${article(noun)}${inputs(input)}; this cannot be undone`)
    default:
      return sentence(`${capitalize(verbOf(input.name))}s ${article(noun)}${inputs(input)}`)
  }
}

/** What a write takes is part of what it does, and it is what a request is phrased in terms of. */
function inputs(input: DescriptionInput): string {
  const required = ((input.inputSchema['required'] as string[] | undefined) ?? []).filter(
    (key) => key !== 'confirm' && key !== 'raw' && !input.path.includes(`{${key}}`),
  )
  return required.length === 0 ? '' : ` from ${required.slice(0, 4).join(', ')}`
}

const article = (noun: string): string => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`

/**
 * An observed value set is the vocabulary a user will phrase their request in ("show me the
 * refunded ones"), so a filter parameter's examples belong in the description, not only in the
 * schema — that is what makes the right tool selectable from words the user actually uses.
 */
function filters(input: DescriptionInput): string {
  const properties = (input.inputSchema['properties'] as Record<string, JsonSchema> | undefined) ?? {}
  const described = Object.entries(properties)
    .filter(([key]) => key !== 'raw' && key !== input.paginationParam)
    .filter(([, value]) => value['x-open-enum'] === true && Array.isArray(value['examples']))
    .map(([key, value]) => `${key} (${(value['examples'] as string[]).join(', ')})`)
  return described.length === 0 ? '' : `, filterable by ${described.join(' and ')}`
}

function returns(input: DescriptionInput): string {
  const shape = describeShape(input.outputSchema, input.object)
  const from = input.primaryPayloadPath === '$' ? '' : ` from \`${input.primaryPayloadPath}\``
  const paged = input.paginated ? ', one page at a time' : ''
  return sentence(`Returns ${shape}${from}${paged}`)
}

function usage(input: DescriptionInput): string {
  const noun = input.object
  if (input.sideEffect === 'destructive') {
    return sentence(`Use it only on an explicit request to ${verbOf(input.name)} ${article(noun)}, and pass confirm`)
  }
  if (input.sideEffect === 'write') {
    return sentence(`Use it when the user asks to ${verbOf(input.name)} ${article(noun)}`)
  }
  return input.addressed
    ? sentence(`Use it when you already know which ${noun} you need`)
    : sentence(`Use it to find ${plural(noun)} or to check their current state before acting on one`)
}

function describeShape(schema: JsonSchema, noun: string): string {
  if (schema['type'] === 'array') {
    const fields = fieldNames((schema['items'] as JsonSchema | undefined) ?? {})
    return fields.length > 0 ? `a list of ${plural(noun)} with ${joinFields(fields)}` : `a list of ${plural(noun)}`
  }
  const fields = fieldNames(schema)
  return fields.length > 0 ? `the ${noun} with ${joinFields(fields)}` : `the ${noun} payload`
}

/** Required fields first: a field every observation carried describes the payload better than one
 * that showed up once, and only the first few fit in a description. */
function fieldNames(schema: JsonSchema, limit = 5): string[] {
  const all = Object.keys((schema['properties'] as Record<string, unknown> | undefined) ?? {})
  const required = new Set((schema['required'] as string[] | undefined) ?? [])
  return [...all.filter((k) => required.has(k)), ...all.filter((k) => !required.has(k))].slice(0, limit)
}

const joinFields = (fields: string[]): string => `${fields.join(', ')}`

const pathParams = (path: string): string[] => [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? '')

const verbOf = (name: string): string => name.split('_')[0] ?? 'call'

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`)

export function limitSentences(text: string, max = MAX_SENTENCES): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0)
    .slice(0, max)
    .join(' ')
    .trim()
}

export interface DescribeOptions {
  model?: ModelClient | undefined
}

/**
 * The model path. Falls back to the deterministic template when no model is configured, when the
 * model fails, or when it returns nothing usable — a description is never allowed to be empty.
 */
export async function describe(candidate: Candidate, options: DescribeOptions = {}): Promise<string> {
  const input = descriptionInput(candidate.tool, candidate.evidence.provenance?.accessible_name)
  if (!options.model) return describeSync(input)

  const payload = buildModelPayload(candidate)
  try {
    const completion = await options.model.complete(buildPrompt(payload))
    const cleaned = boundDescription(completion.replace(/\s+/g, ' ').trim())
    return cleaned.length > 0 ? cleaned : describeSync(input)
  } catch {
    return describeSync(input)
  }
}

export interface ModelPayload {
  name: string
  method: string
  path: string
  side_effect: SideEffect
  observations: number
  annotation?: string
  provenance?: string
  sample: {
    request_headers: Record<string, string>
    request_body: unknown
    response_body: unknown
  }
}

/**
 * AC-INF-006.4 — only redacted payloads reach a model. Redaction is re-run here rather than
 * trusted from upstream, and the credential-shape gate fails the call closed: no description is
 * worth leaking a session (TR-6).
 */
export function buildModelPayload(candidate: Candidate): ModelPayload {
  const { tool, evidence } = candidate
  const sample = evidence.sample
  const payload: ModelPayload = {
    name: tool.name,
    method: tool.request.method,
    path: tool.request.path,
    side_effect: tool.side_effect,
    observations: tool.observations,
    ...(tool.annotation !== undefined ? { annotation: tool.annotation } : {}),
    ...(evidence.provenance !== undefined ? { provenance: evidence.provenance.accessible_name } : {}),
    sample: {
      request_headers: redactHeaders(sample.request_headers),
      request_body: redactBody(sample.request_body),
      response_body: redactBody(sample.response_body),
    },
  }

  const leaked = findSurvivingSecrets(payload)
  if (leaked.length > 0) {
    throw new Error(
      `refusing to send tool "${tool.name}" to a model: credential-shaped value at ${leaked.join(', ')}`,
    )
  }
  return payload
}

export function buildPrompt(payload: ModelPayload): string {
  return [
    'You are writing an MCP tool description that an AI agent reads to decide whether to call it.',
    `Write at most ${MAX_SENTENCES} sentences: what the tool does, what it returns, when to use it.`,
    'Do not mention HTTP, JSON, or the words "endpoint" or "API". Reply with the description only.',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}
