import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RECIPE_VERSION,
  Recipe,
  parseRecipe,
  serializeRecipe,
  type Exchange,
  type Tool,
} from '@douze/shared'
import { readFixtures, toFixture, writeFixture, type Fixture } from './fixtures.js'
import { infer, type InferenceInput } from './inference/engine.js'
import { PATH_CREDENTIAL_PARAM } from './inference/templating.js'
import { mergeRecipe, setField, MERGEABLE_FIELDS, type MergeReport } from './merge.js'
import { studioPaths, type StudioPaths } from './paths.js'
import { approve, approveReads, unapprove, type BulkResult } from './promotion.js'
import type { Candidate } from './types.js'

export interface StudioConfig {
  /** Recipe file name, kebab-case (`Recipe` validates it). */
  recipeName: string
  baseUrl: string
  paths?: StudioPaths
  auth?: Partial<Recipe['auth']>
}

export type EditableField = (typeof MERGEABLE_FIELDS)[number]

/** AC-REC-002.1 — one candidate as the review UI needs to see it, evidence included. */
export interface CandidateView {
  name: string
  description: string
  side_effect: Tool['side_effect']
  confidence: number
  observations: number
  approved: boolean
  /** AC-REC-002.3 — false for write and destructive, which need individual approval. */
  bulk_approvable: boolean
  annotation: string | undefined
  provenance: string | undefined
  route: string | undefined
  request: Tool['request']
  response: Tool['response']
  flags: Tool['flags']
  /** Redacted by #CaptureStore on write and never un-redacted here. */
  sample: {
    method: string
    url: string
    status: number
    request_body: unknown
    response_body: unknown
  }
}

export interface SaveReport extends MergeReport {
  path: string
  fixtures: string[]
}

/**
 * #ReviewApp state. Holds candidates in memory for the life of a review and writes only to the
 * recipe and fixture directories (ADR-006) — douzed keeps one of these per capture session.
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
    const candidates = infer(input)
    degradeUnfillablePathCredentials(candidates, auth)
    return new StudioSession(auth ? { ...config, auth } : config, candidates)
  }

  find(name: string): Candidate {
    const candidate = this.candidates.find((c) => c.tool.name === name)
    if (!candidate) throw new Error(`no candidate named "${name}"`)
    return candidate
  }

  view(): CandidateView[] {
    return this.candidates.map((c) => ({
      name: c.tool.name,
      description: c.tool.description,
      side_effect: c.tool.side_effect,
      confidence: c.tool.confidence,
      observations: c.tool.observations,
      approved: c.tool.approved,
      bulk_approvable: c.tool.side_effect === 'read',
      annotation: c.evidence.annotation,
      provenance: c.evidence.provenance?.accessible_name,
      route: c.evidence.provenance?.route,
      request: c.tool.request,
      response: c.tool.response,
      flags: c.tool.flags,
      sample: {
        method: c.evidence.sample.method,
        url: c.evidence.sample.url,
        status: c.evidence.sample.status,
        request_body: c.evidence.sample.request_body,
        response_body: c.evidence.sample.response_body,
      },
    }))
  }

  /** AC-REC-002.2 — an inline edit is written to the recipe and the field marked `user_edited`. */
  edit(name: string, field: EditableField, value: unknown): Candidate {
    if (!MERGEABLE_FIELDS.includes(field)) throw new Error(`field "${field}" is not editable`)
    const candidate = this.find(name)
    setField(candidate.tool, field, value)
    const edited = new Set(candidate.tool.flags.user_edited)
    edited.add(field)
    candidate.tool.flags.user_edited = [...edited].sort()
    return candidate
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

  /**
   * Writes fixtures first, then the recipe: `Recipe` refuses to serialize an approved tool with no
   * fixture (AC-REC-004.1), so the order is load-bearing rather than incidental.
   */
  save(): SaveReport {
    mkdirSync(this.paths.recipes, { recursive: true })
    const written: string[] = []
    for (const candidate of this.candidates) {
      if (!candidate.tool.approved) continue
      const reference = writeFixture(
        this.paths.fixtures,
        this.config.recipeName,
        toFixture(candidate.tool.name, candidate.evidence.sample),
      )
      candidate.tool.fixtures = [reference]
      written.push(reference)
    }

    const fresh = this.candidates.map((c) => c.tool)
    const existing = this.loadExisting()
    const report: MergeReport = existing
      ? mergeRecipe(existing, fresh, { fixtures: this.fixturesByTool() })
      : { recipe: this.buildRecipe(fresh), preserved: [], retained: [], conflicts: [], added: fresh.map((t) => t.name) }

    /**
     * AC-EXE-001.3 — auth follows the capture, on every save and not just the first.
     *
     * `mergeRecipe` builds on the EXISTING recipe, which carries the auth block it was written
     * with. Re-recording a site therefore never updated it: a recipe first saved with the schema
     * default `cookie` kept sending no credential no matter how many times the site was recorded
     * again, and every call failed with "you have been signed out". A capture that shows no
     * page-supplied credential derives nothing and leaves whatever is there — including a
     * hand-written block — alone.
     */
    const recipe = this.config.auth ? { ...report.recipe, auth: { ...report.recipe.auth, ...this.config.auth } } : report.recipe

    const path = join(this.paths.recipes, `${this.config.recipeName}.yaml`)
    writeFileSync(path, serializeRecipe(Recipe.parse(recipe)), { mode: 0o600 })
    return { ...report, path, fixtures: written }
  }

  private buildRecipe(tools: Tool[]): Recipe {
    return Recipe.parse({
      version: RECIPE_VERSION,
      name: this.config.recipeName,
      enabled: true,
      target: { base_url: this.config.baseUrl },
      ...(this.config.auth !== undefined ? { auth: this.config.auth } : {}),
      tools,
    })
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

/** The origin most exchanges came from, which is the target's base URL. */
/**
 * The auth block a capture implies: every distinct credential the page was seen supplying, plus
 * the origin whose tab has to run the call for those credentials to be readable and for the
 * target's CORS to accept it.
 *
 * Returns undefined when the capture shows no page-supplied credential — a cookie-authenticated
 * site, where the schema default is already right.
 */
export function authFrom(exchanges: Exchange[]): Partial<Recipe['auth']> | undefined {
  type Source = { kind: 'page_state'; expression: string; header?: string; param?: string; prefix: string }
  const sources = new Map<string, Source>()
  const pageOrigins = new Map<string, number>()

  for (const exchange of exchanges) {
    if (exchange.page_origin) pageOrigins.set(exchange.page_origin, (pageOrigins.get(exchange.page_origin) ?? 0) + 1)
    for (const hint of exchange.credentials ?? []) {
      // Keyed by destination: one Authorization per recipe, however many times it was observed,
      // and one parameter per expression for the values that live in the URL.
      if (hint.header) {
        const key = `header:${hint.header.toLowerCase()}`
        if (!sources.has(key)) {
          sources.set(key, { kind: 'page_state', expression: hint.expression, header: hint.header, prefix: hint.prefix })
        }
      } else if (hint.segment !== undefined) {
        const key = `param:${hint.expression}`
        if (!sources.has(key)) {
          sources.set(key, { kind: 'page_state', expression: hint.expression, param: PATH_CREDENTIAL_PARAM, prefix: '' })
        }
      }
    }
  }
  if (sources.size === 0) return undefined

  // The busiest page origin: a capture can touch more than one, and the one that issued most of
  // the traffic is the one whose session the tools belong to.
  const [busiest] = [...pageOrigins.entries()].sort((a, b) => b[1] - a[1])
  return {
    mode: 'browser_relay',
    credential_source: [...sources.values()],
    ...(busiest ? { page_origin: busiest[0] } : {}),
  }
}

/**
 * A redacted path segment becomes `{project_key}`, deliberately left out of the input schema
 * because the page fills it at call time, not the caller. When the capture carries no credential
 * hint to fill it — every HAR import does, they have no `credentials` at all — the saved tool is
 * uncallable: the relay substitutes nothing and the request goes to `/v1/project/apikey//origins`.
 * Marked degraded with the reason, which is the same channel a Doctor Run uses, rather than saved
 * as though it worked.
 */
function degradeUnfillablePathCredentials(candidates: Candidate[], auth: Partial<Recipe['auth']> | undefined): void {
  const fillable = (auth?.credential_source ?? []).some(
    (source) => source.kind === 'page_state' && source.param === PATH_CREDENTIAL_PARAM,
  )
  if (fillable) return
  for (const candidate of candidates) {
    if (!candidate.tool.request.path.includes(`{${PATH_CREDENTIAL_PARAM}}`)) continue
    candidate.tool.flags.degraded = true
    candidate.tool.flags.degraded_reason =
      `the ${PATH_CREDENTIAL_PARAM} in this path was redacted, and this capture shows no page ` +
      `credential that could fill it — record the site again from the tab that uses it`
  }
}

export function baseUrlFrom(exchanges: Exchange[]): string {
  const counts = new Map<string, number>()
  for (const exchange of exchanges) counts.set(exchange.origin, (counts.get(exchange.origin) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return top?.[0] ?? 'http://localhost'
}

