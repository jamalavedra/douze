import type { JsonSchema } from '../types.js'

/** AC-INF-002.2 — an open enum needs at least this many observations to be worth emitting. */
const MIN_ENUM_OBSERVATIONS = 3
/** AC-INF-002.2 — above this many distinct values the field is free-form, not an enum. */
const MAX_ENUM_VALUES = 12

/**
 * REQ-INF-002 — derives JSON Schema from observed values.
 *
 * A field is required only when it is present in every observation (AC-INF-002.1). String fields
 * with a small, stable value set become open enums (AC-INF-002.2): the values are emitted as
 * `examples` with an `x-open-enum` marker rather than a closed `enum`, so a JSON Schema → Zod
 * conversion at load time yields `z.string()` and an unseen-but-valid value is not rejected
 * (AC-INF-002.4).
 */
export function inferSchema(samples: readonly unknown[]): JsonSchema {
  const present = samples.filter((s) => s !== undefined)
  if (present.length === 0) return {}

  if (present.every(isPlainObject)) return objectSchema(present as Record<string, unknown>[])
  if (present.every(Array.isArray)) return { type: 'array', items: inferSchema(present.flat()) }
  if (present.every((s) => typeof s === 'string')) return stringSchema(present as string[])
  if (present.every((s) => typeof s === 'number')) {
    return { type: present.every((s) => Number.isInteger(s)) ? 'integer' : 'number' }
  }
  if (present.every((s) => typeof s === 'boolean')) return { type: 'boolean' }
  if (present.every((s) => s === null)) return { type: 'null' }
  // Mixed types across observations: an unconstrained schema is honest, a guess is not.
  return {}
}

function objectSchema(samples: Record<string, unknown>[]): JsonSchema {
  const keys = [...new Set(samples.flatMap((s) => Object.keys(s)))].sort()
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const key of keys) {
    const values = samples.filter((s) => key in s).map((s) => s[key])
    properties[key] = inferSchema(values)
    // AC-INF-002.1 — required iff present in every observation.
    if (values.length === samples.length) required.push(key)
  }
  const schema: JsonSchema = { type: 'object', properties }
  if (required.length > 0) schema['required'] = required
  return schema
}

function stringSchema(values: string[]): JsonSchema {
  const distinct = [...new Set(values)].sort()
  if (values.length >= MIN_ENUM_OBSERVATIONS && distinct.length < MAX_ENUM_VALUES) {
    return { type: 'string', 'x-open-enum': true, examples: distinct }
  }
  return { type: 'string' }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Merges independently inferred property sets into one input schema (path + query + body). */
export function mergeSchemas(...schemas: JsonSchema[]): JsonSchema {
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  for (const schema of schemas) {
    Object.assign(properties, (schema['properties'] as Record<string, unknown> | undefined) ?? {})
    for (const key of (schema['required'] as string[] | undefined) ?? []) required.add(key)
  }
  const merged: JsonSchema = { type: 'object', properties }
  if (required.size > 0) merged['required'] = [...required].sort()
  return merged
}

/**
 * Schema stability: the share of observed fields that held across every observation. A tool whose
 * fields come and go is a weaker candidate than one with a fixed shape (REQ-INF-002 confidence).
 */
export function stability(schema: JsonSchema): number {
  const properties = (schema['properties'] as Record<string, unknown> | undefined) ?? {}
  const total = Object.keys(properties).length
  if (total === 0) return 1
  return ((schema['required'] as string[] | undefined) ?? []).length / total
}
