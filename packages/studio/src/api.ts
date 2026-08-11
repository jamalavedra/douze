import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Recipe, parseRecipe, serializeRecipe } from '@douze/shared'
import {
  authFrom,
  candidateViews,
  candidatesFrom,
  editCandidate,
  findCandidate,
  prepareSave,
  type CandidateView,
  type EditableField,
  type RecipeConfig,
} from './candidates.js'
import { assertFixtureSafe, fixtureReference, type Fixture } from './fixtures.js'
import type { InferenceInput } from './inference/engine.js'
import type { MergeReport } from './merge.js'
import { studioPaths, type StudioPaths } from './paths.js'
import { approve, approveReads, unapprove, type BulkResult } from './promotion.js'
import type { Candidate } from './types.js'

export interface StudioConfig extends RecipeConfig {
  paths?: StudioPaths
}

export interface SaveReport extends MergeReport {
  path: string
  fixtures: string[]
}

/**
 * #ReviewApp state on a filesystem. The review logic itself lives in `candidates.ts` and is pure;
 * this class is the persistence half — it writes only to the recipe and fixture directories
 * (ADR-006) — and douzed keeps one of these per capture session.
 */
export class StudioSession {
  readonly paths: StudioPaths

  constructor(
    readonly config: StudioConfig,
    readonly candidates: Candidate[],
  ) {
    this.paths = config.paths ?? studioPaths()
  }

  static fromExchanges(config: StudioConfig, input: InferenceInput): StudioSession {
    // AC-EXE-001.3 — the auth block is derived from the capture unless the caller pinned one. A
    // recipe whose auth is the schema default (`cookie`) sends no credential at all, which is why
    // a token-authenticated dashboard recorded, inferred and saved cleanly and then failed on its
    // first call with "you have been signed out".
    const auth = config.auth ?? authFrom(input.exchanges)
    const candidates = candidatesFrom(input, auth)
    return new StudioSession(auth ? { ...config, auth } : config, candidates)
  }

  find(name: string): Candidate {
    return findCandidate(this.candidates, name)
  }

  view(): CandidateView[] {
    return candidateViews(this.candidates)
  }

  edit(name: string, field: EditableField, value: unknown): Candidate {
    return editCandidate(this.find(name), field, value)
  }

  approveReads(): BulkResult {
    return approveReads(this.candidates)
  }

  approve(name: string): Candidate {
    return approve(this.find(name))
  }

  unapprove(name: string): Candidate {
    return unapprove(this.find(name))
  }

  /** Fixtures first, then the recipe — the order `prepareSave` documents. */
  save(): SaveReport {
    mkdirSync(this.paths.recipes, { recursive: true })
    const prepared = prepareSave(this.config, this.candidates, this.loadExisting(), this.fixturesByTool())
    const written: string[] = []
    for (const { reference, fixture } of prepared.fixtures) {
      writeFixture(this.paths.fixtures, this.config.recipeName, fixture)
      written.push(reference)
    }

    const path = join(this.paths.recipes, `${this.config.recipeName}.yaml`)
    writeFileSync(path, serializeRecipe(prepared.recipe), { mode: 0o600 })
    return { ...prepared, path, fixtures: written }
  }

  private loadExisting(): Recipe | null {
    const path = join(this.paths.recipes, `${this.config.recipeName}.yaml`)
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    const result = parseRecipe(source, `${this.config.recipeName}.yaml`)
    return result.ok && result.recipe ? result.recipe : null
  }

  private fixturesByTool(): Record<string, Fixture[]> {
    const out: Record<string, Fixture[]> = {}
    for (const fixture of readFixtures(this.paths.fixtures, this.config.recipeName)) {
      ;(out[fixture.tool] ??= []).push(fixture)
    }
    return out
  }
}

/** AC-REC-004.1 — the gate runs again here, so a direct write cannot skip it. */
export function writeFixture(fixturesDir: string, recipe: string, fixture: Fixture): string {
  assertFixtureSafe(fixture)
  const relative = fixtureReference(recipe, fixture.tool)
  const absolute = join(fixturesDir, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 })
  return relative
}

export function readFixtures(fixturesDir: string, recipe: string): Fixture[] {
  let entries: string[]
  try {
    entries = readdirSync(join(fixturesDir, recipe))
  } catch {
    return []
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(fixturesDir, recipe, name), 'utf8')) as Fixture)
}
