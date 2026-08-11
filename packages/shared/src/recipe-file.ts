import { parse, stringify } from 'yaml'
import { Recipe, RECIPE_VERSION } from './recipe.js'
import { findSurvivingSecrets } from './redact.js'

export interface LoadResult {
  ok: boolean
  recipe?: Recipe
  /** AC-REC-001.4 — named so the runtime can report the failure by recipe name. */
  error?: string
  /** AC-REC-001.3 — every field a migration altered. */
  migrated?: string[]
}

/**
 * AC-REC-001.3 — migrations run in order from the document's version to RECIPE_VERSION and
 * report every field they touch. Each entry mutates the raw document in place.
 */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => string[]> = {
  // v0 predates the auth descriptor; everything captured then was cookie-based browser relay.
  0: (doc) => {
    doc['auth'] = { mode: 'browser_relay', credential_source: [{ kind: 'cookie' }] }
    return ['auth']
  },
}

export function parseRecipe(source: string, filename: string): LoadResult {
  let raw: unknown
  try {
    raw = parse(source)
  } catch (cause) {
    return { ok: false, error: `${filename}: invalid YAML — ${(cause as Error).message}` }
  }
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: `${filename}: recipe must be a YAML mapping` }
  }

  const doc = raw as Record<string, unknown>
  const migrated: string[] = []
  let version = typeof doc['version'] === 'number' ? doc['version'] : 0
  while (version < RECIPE_VERSION) {
    const migration = MIGRATIONS[version]
    if (!migration) return { ok: false, error: `${filename}: no migration from version ${version}` }
    migrated.push(...migration(doc))
    version += 1
    doc['version'] = version
  }

  const parsed = Recipe.safeParse(doc)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    return { ok: false, error: `${filename}: ${issues}` }
  }

  /**
   * A YAML anchor that contains itself (`input_schema: &s { self: *s }`) parses into a cyclic
   * object, and zod keeps it: `z.unknown()` passes a value through by reference. Everything
   * downstream then fails in a way that names nothing — `RecipeStore.recompute` JSON.stringifies
   * the surface and throws a raw TypeError, and a host frame carrying it cannot be serialised at
   * all. A recipe is a data document; a cycle in one is not a recipe, and the reader deserves the
   * sentence rather than the stack.
   */
  if (isCircular(parsed.data)) {
    return {
      ok: false,
      error: `${filename}: contains a circular reference — a YAML anchor (&name/*name) that includes itself`,
    }
  }

  // AC-REC-001.2 / TR-6 — a recipe that carries a credential value is not loadable at all.
  const leaked = findSurvivingSecrets(parsed.data)
  if (leaked.length > 0) {
    return { ok: false, error: `${filename}: credential-shaped value at ${leaked.join(', ')}` }
  }

  return { ok: true, recipe: parsed.data, migrated }
}

/** The cheapest complete test for a cycle is the serialiser that will hit it first anyway. */
function isCircular(value: unknown): boolean {
  try {
    JSON.stringify(value)
    return false
  } catch (cause) {
    if (cause instanceof TypeError) return true
    throw cause
  }
}

export function serializeRecipe(recipe: Recipe): string {
  const leaked = findSurvivingSecrets(recipe)
  if (leaked.length > 0) {
    throw new Error(`refusing to write recipe "${recipe.name}": credential at ${leaked.join(', ')}`)
  }
  return stringify(recipe, { lineWidth: 100 })
}
