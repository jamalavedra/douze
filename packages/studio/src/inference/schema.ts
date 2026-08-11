import type { JsonSchema } from '../types.js'

/** AC-INF-002.2 — an open enum needs at least this many observations to be worth emitting. */
const MIN_ENUM_OBSERVATIONS = 3
/** AC-INF-002.2 — above this many distinct values the field is free-form, not an enum. */
const MAX_ENUM_VALUES = 12

/**
 * The ceiling rule for an observed number: ten times the largest magnitude seen, never below the
 * floor.
 *
 * An observation bounds the magnitude the *app* worked in, not the magnitude a caller may
 * legitimately ask for — an app that fetched 20 rows a page does not make `limit=50` wrong, and
 * refusing it would break ordinary use for nothing. An order of magnitude of headroom keeps every
 * plausible variation of what was recorded and still refuses the magnitudes that turn a recorded
 * read into a bulk export (`limit=1000000` against an observed 20).
 *
 * The floor is what stops one observation from pinning the ceiling to itself: a single `page=1`
 * would otherwise forbid page 2. Below ~1000 a bound is far likelier to refuse an ordinary call
 * than to prevent anything interesting, so that is where it sits.
 */
const CEILING_HEADROOM = 10
const CEILING_FLOOR = 1000

/**
 * Keys whose magnitude carries no information: order 1042 says nothing about whether order 99999
 * exists, so a ceiling derived from one identifier would refuse the next. Ids get a type and no
 * bound.
 */
const IDENTIFIER_KEY = /(^|_)ids?$|Ids?$/

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
  if (present.every((s) => typeof s === 'number')) return numberSchema(present as number[])
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
    const schema = inferSchema(values)
    properties[key] = IDENTIFIER_KEY.test(key) ? withoutCeiling(schema) : schema
    // AC-INF-002.1 — required iff present in every observation.
    if (values.length === samples.length) required.push(key)
  }
  const schema: JsonSchema = { type: 'object', properties }
  if (required.length > 0) schema['required'] = required
  return schema
}

/**
 * A number gets a ceiling as well as a type, so an observed `limit=20` stops permitting
 * `limit=1000000`. Bounded by magnitude rather than by the observed maximum, so a field the app
 * sent as `-25` is bounded at both ends.
 */
function numberSchema(values: number[]): JsonSchema {
  const type = values.every(Number.isInteger) ? 'integer' : 'number'
  const observed = Math.max(...values.map(Math.abs))
  if (!Number.isFinite(observed)) return { type }
  const bound = Math.max(CEILING_FLOOR, Math.ceil(observed * CEILING_HEADROOM))
  return { type, minimum: -bound, maximum: bound }
}

const withoutCeiling = (schema: JsonSchema): JsonSchema => {
  const { minimum: _minimum, maximum: _maximum, ...rest } = schema
  return rest
}

/**
 * Query values arrive as strings, which is how an observed `limit=20` ended up with no ceiling at
 * all — a string schema constrains no magnitude. A value is treated as the number it plainly is
 * only when the decimal round-trips exactly, so `zip=02138`, `version=1.10` and `id=1e5` stay
 * strings rather than being silently rewritten into a different value on the way out.
 *
 * Identifier keys stay strings whatever they look like: an id is opaque, and typing it from the one
 * the app happened to use is a guess with no upside.
 */
export function coerceNumericValues(query: Record<string, string>): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(query)) {
    const parsed = Number(value)
    const numeric = value.trim() !== '' && Number.isFinite(parsed) && String(parsed) === value
    out[key] = numeric && !IDENTIFIER_KEY.test(key) ? parsed : value
  }
  return out
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
