import type { Recipe, Tool } from '@douze/shared'
import type { Fixture } from './fixtures.js'
import type { JsonSchema } from './types.js'

/** Fields a user can hand-edit in review and therefore fields re-inference must not clobber. */
export const MERGEABLE_FIELDS = [
  'name',
  'description',
  'side_effect',
  'request.input_schema',
  'response.output_schema',
  'response.primary_payload_path',
] as const

export interface MergeReport {
  recipe: Recipe
  /** AC-REC-003.1 — user values kept; the inferred alternative lives in `flags.suggestions`. */
  preserved: { tool: string; field: string }[]
  /** AC-REC-003.2 — tools the new capture did not observe, retained and marked `unverified`. */
  retained: string[]
  /** AC-REC-003.3 — schema changes that invalidate a fixture. Those tools are left untouched. */
  conflicts: { tool: string; reason: string }[]
  added: string[]
}

/** What actually identifies a tool: the request it makes, not the name a user gave it. */
function identity(tool: Tool): string {
  const { method, path, graphql } = tool.request
  return graphql ? `graphql|${graphql.operation}` : `${method}|${path}`
}

export interface MergeOptions {
  /** Stored fixtures by tool name, used for the AC-REC-003.3 conflict check. */
  fixtures?: Record<string, Fixture[]>
  today?: string
}

/**
 * REQ-REC-003 — non-destructive regeneration. Re-inference improves what the user has not touched
 * and never overwrites what they have; a recipe that punished editing would not be worth editing.
 */
export function mergeRecipe(existing: Recipe, incoming: Tool[], options: MergeOptions = {}): MergeReport {
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const fixtures = options.fixtures ?? {}
  const byName = new Map(incoming.map((tool) => [tool.name, tool]))
  /**
   * AC-REC-003.1 — `name` is user-editable, so a renamed tool must still be recognised as the
   * same tool on re-inference. Matching on name alone means a rename produces a duplicate: the
   * renamed tool is marked `unverified` even though its traffic was observed, and the freshly
   * inferred one is added alongside under the old name. Request identity is what actually
   * identifies a tool.
   */
  const byIdentity = new Map(incoming.map((tool) => [identity(tool), tool]))
  const report: MergeReport = { recipe: existing, preserved: [], retained: [], conflicts: [], added: [] }

  const tools: Tool[] = []
  for (const current of existing.tools) {
    const fresh = byName.get(current.name) ?? byIdentity.get(identity(current))
    if (!fresh) {
      // AC-REC-003.2 — absent from this capture is not the same as gone.
      tools.push({
        ...current,
        flags: { ...current.flags, unverified: true, last_observed: current.flags.last_observed ?? today },
      })
      report.retained.push(current.name)
      continue
    }
    byName.delete(fresh.name)
    byIdentity.delete(identity(fresh))

    const conflict = fixtureConflict(fresh, fixtures[current.name] ?? [])
    if (conflict !== undefined) {
      // AC-REC-003.3 — report and leave the recipe alone until the user resolves it.
      report.conflicts.push({ tool: current.name, reason: conflict })
      tools.push(current)
      continue
    }
    tools.push(mergeTool(current, fresh, report))
  }

  for (const fresh of byName.values()) {
    tools.push(fresh)
    report.added.push(fresh.name)
  }

  report.recipe = { ...existing, tools }
  return report
}

function mergeTool(current: Tool, fresh: Tool, report: MergeReport): Tool {
  const merged = structuredClone(current)
  const suggestions: Record<string, unknown> = { ...current.flags.suggestions }
  const edited = new Set(current.flags.user_edited)

  for (const field of MERGEABLE_FIELDS) {
    const inferred = getField(fresh, field)
    if (inferred === undefined) continue
    if (edited.has(field)) {
      // AC-REC-003.1 — the user wins, but the inferred value is not thrown away.
      if (JSON.stringify(inferred) !== JSON.stringify(getField(current, field))) {
        suggestions[field] = inferred
        report.preserved.push({ tool: current.name, field })
      }
      continue
    }
    setField(merged, field, inferred)
  }

  merged.confidence = fresh.confidence
  merged.observations = fresh.observations
  merged.request.method = fresh.request.method
  merged.request.path = fresh.request.path
  if (fresh.request.graphql !== undefined) merged.request.graphql = fresh.request.graphql
  merged.flags = {
    ...merged.flags,
    sparse: fresh.flags.sparse,
    derived_name: fresh.flags.derived_name,
    unverified: false,
    suggestions,
    ...(fresh.flags.last_observed !== undefined ? { last_observed: fresh.flags.last_observed } : {}),
  }
  return merged
}

/**
 * AC-REC-003.3 — a stored fixture is only valid while the schema it was captured under still
 * accepts it. A newly required request field the fixture never carried is the common case.
 */
function fixtureConflict(fresh: Tool, fixtures: Fixture[]): string | undefined {
  if (fixtures.length === 0) return undefined
  const required = ((fresh.request.input_schema as JsonSchema)['required'] as string[] | undefined) ?? []
  for (const fixture of fixtures) {
    const body = fixture.request.body
    const present = new Set([
      ...(body !== null && typeof body === 'object' ? Object.keys(body) : []),
      ...pathKeys(fresh.request.path),
      ...queryKeys(fixture.request.url),
    ])
    const missing = required.filter((key) => key !== 'confirm' && key !== 'raw' && !present.has(key))
    if (missing.length > 0) {
      return `fixture ${fixture.tool}.json lacks newly required field(s): ${missing.sort().join(', ')}`
    }
  }
  return undefined
}

const pathKeys = (path: string): string[] => [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? '')

function queryKeys(url: string): string[] {
  try {
    return [...new URL(url).searchParams.keys()]
  } catch {
    return []
  }
}

type FieldPath = (typeof MERGEABLE_FIELDS)[number]

export function getField(tool: Tool, field: FieldPath): unknown {
  const [head, tail] = field.split('.') as [string, string | undefined]
  const record = tool as unknown as Record<string, unknown>
  if (tail === undefined) return record[head]
  const nested = record[head]
  return nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>)[tail] : undefined
}

export function setField(tool: Tool, field: FieldPath, value: unknown): void {
  const [head, tail] = field.split('.') as [string, string | undefined]
  const record = tool as unknown as Record<string, unknown>
  if (tail === undefined) {
    record[head] = value
    return
  }
  const nested = record[head]
  if (nested !== null && typeof nested === 'object') (nested as Record<string, unknown>)[tail] = value
}
