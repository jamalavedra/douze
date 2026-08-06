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
    return new StudioSession(config, infer(input))
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

    const path = join(this.paths.recipes, `${this.config.recipeName}.yaml`)
    writeFileSync(path, serializeRecipe(Recipe.parse(report.recipe)), { mode: 0o600 })
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
export function baseUrlFrom(exchanges: Exchange[]): string {
  const counts = new Map<string, number>()
  for (const exchange of exchanges) counts.set(exchange.origin, (counts.get(exchange.origin) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return top?.[0] ?? 'http://localhost'
}

