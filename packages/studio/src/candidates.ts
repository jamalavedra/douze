/**
 * Review without a filesystem: infer candidates, show them, edit them, and work out exactly what
 * has to be persisted — but never persist it. `api.ts` supplies the filesystem half for douzed;
 * the extension supplies extension storage (WO-015 T-015.2). Nothing here touches `node:*`.
 */
import { RECIPE_VERSION, Recipe, type Exchange, type Tool } from '@douze/shared'
import { describeSync, descriptionInput } from './descriptions/writer.js'
import { assertFixtureSafe, fixtureReference, toFixture, type Fixture } from './fixtures.js'
import { infer, type InferenceInput } from './inference/engine.js'
import { PATH_CREDENTIAL_PARAM } from './inference/templating.js'
import { mergeRecipe, setField, MERGEABLE_FIELDS, type MergeReport } from './merge.js'
import { injectConfirm } from './promotion.js'
import type { Candidate, JsonSchema } from './types.js'

export interface RecipeConfig {
  /** Recipe file name, kebab-case (`Recipe` validates it). */
  recipeName: string
  baseUrl: string
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

/** Inference plus the degradation pass that depends on the recipe's auth block. */
export function candidatesFrom(input: InferenceInput, auth: Partial<Recipe['auth']> | undefined): Candidate[] {
  const candidates = infer(input)
  degradeUnfillablePathCredentials(candidates, auth)
  return candidates
}

export function findCandidate(candidates: Candidate[], name: string): Candidate {
  const candidate = candidates.find((c) => c.tool.name === name)
  if (!candidate) throw new Error(`no candidate named "${name}"`)
  return candidate
}

export function candidateViews(candidates: Candidate[]): CandidateView[] {
  return candidates.map((c) => ({
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

/** AC-REC-002.2 — an inline edit sets the field and marks it `user_edited`. */
export function editCandidate(candidate: Candidate, field: EditableField, value: unknown): Candidate {
  if (!MERGEABLE_FIELDS.includes(field)) throw new Error(`field "${field}" is not editable`)
  if (field === 'side_effect') return reclassify(candidate, value)
  setField(candidate.tool, field, value)
  markEdited(candidate, field)
  return candidate
}

function markEdited(candidate: Candidate, ...fields: EditableField[]): void {
  const edited = new Set(candidate.tool.flags.user_edited)
  for (const field of fields) edited.add(field)
  candidate.tool.flags.user_edited = [...edited].sort()
}

/**
 * WO-016 — the human backstop for `classify`, which is a heuristic over *names* and will always be
 * incomplete. `suspendAccount` sitting under "Make changes" is a judgement no regex settles, and
 * `POST /transfers/search` under "Remove things" is a read that no hosted assistant can reach for
 * no reason at all. Both are corrections a reviewer can now make, through the same edit plumbing
 * that carries a name and a description.
 *
 * `read` is deliberately not a target. Both `write` and `destructive` are strictly LESS reachable
 * than `read`, so every move offered here narrows what an assistant may do; a hand-set `read`
 * would be the one move that widens it — turning a POST into something a hosted assistant may call
 * with no write opt-in at all — which is exactly the mistake this control exists to catch.
 *
 * Two things travel with the label, because neither is optional:
 *  - the `confirm` parameter, which `Recipe` demands of every approved destructive tool and
 *    refuses to serialize without (`prepareSave` re-asserts it; this is what the reader sees);
 *  - the description, rewritten from the new class. It carries "this cannot be undone" and "pass
 *    confirm", and a description still phrased as a write while the policy demands a confirm is
 *    worse than either on its own.
 *
 * Both fields are marked `user_edited`, so a re-record offers inference's guess in
 * `flags.suggestions` (AC-REC-003.1) instead of quietly reverting the correction.
 */
function reclassify(candidate: Candidate, value: unknown): Candidate {
  if (value !== 'write' && value !== 'destructive') {
    throw new Error(`side_effect "${String(value)}" cannot be set by hand — choose "write" or "destructive"`)
  }
  const tool = candidate.tool
  tool.side_effect = value
  tool.request.input_schema =
    value === 'destructive' ? injectConfirm(tool.request.input_schema) : withoutConfirm(tool.request.input_schema)
  // A description that still says "makes changes" on a tool the policy now treats as irreversible
  // is worse than either alone, so the class has to reach the text. But a description the user
  // wrote themselves is theirs: overwriting it with the template silently discards the one part of
  // this screen where they explained the tool in their own words. So a generated description is
  // regenerated, and a hand-written one keeps its wording and gains the sentence the policy needs.
  const wrote = candidate.tool.flags.user_edited.includes('description')
  const generated = describeSync(descriptionInput(tool, candidate.evidence.provenance?.accessible_name))
  tool.description = wrote ? withConsequence(tool.description, value) : generated
  markEdited(candidate, 'side_effect', ...(wrote ? [] : (['description'] as EditableField[])))
  return candidate
}

/**
 * Keeps the user's own words and makes the class explicit in them. The phrasing matches what
 * `describeSync` generates for a destructive tool, so a hand-written and a generated description
 * say the same thing about consequence even though they differ everywhere else.
 */
function withConsequence(description: string, side_effect: 'write' | 'destructive'): string {
  const stripped = description.replace(/;? ?this cannot be undone\.?$/i, '').replace(/\.$/, '')
  return side_effect === 'destructive' ? `${stripped}; this cannot be undone` : stripped
}

/** The other half of AC-REC-002.4: a demoted tool stops demanding a word it no longer means. */
function withoutConfirm(schema: JsonSchema): JsonSchema {
  const properties = { ...(schema['properties'] as Record<string, unknown> | undefined) }
  delete properties['confirm']
  const required = ((schema['required'] as string[] | undefined) ?? []).filter((key) => key !== 'confirm')
  return { ...schema, properties, required }
}

export interface PreparedSave extends MergeReport {
  /**
   * Every fixture an approved candidate needs, already through the credential gate. Persist these
   * before the recipe: `Recipe` refuses to serialize an approved tool with no fixture
   * (AC-REC-004.1), so the order is load-bearing rather than incidental.
   */
  fixtures: { reference: string; fixture: Fixture }[]
}

/**
 * Everything `save()` does except the writing: candidates in, a validated recipe and the fixtures
 * it depends on out. `existing` and `storedFixtures` are what the caller's store already holds.
 */
export function prepareSave(
  config: RecipeConfig,
  candidates: Candidate[],
  existing: Recipe | null,
  storedFixtures: Record<string, Fixture[]> = {},
): PreparedSave {
  const fixtures: { reference: string; fixture: Fixture }[] = []
  for (const candidate of candidates) {
    if (!candidate.tool.approved) continue
    const fixture = toFixture(candidate.tool.name, candidate.evidence.sample)
    assertFixtureSafe(fixture)
    const reference = fixtureReference(config.recipeName, candidate.tool.name)
    candidate.tool.fixtures = [reference]
    fixtures.push({ reference, fixture })
  }

  const fresh = candidates.map((c) => c.tool)
  const report: MergeReport = existing
    ? mergeRecipe(existing, fresh, { fixtures: storedFixtures })
    : {
        recipe: buildRecipe(config, fresh),
        preserved: [],
        retained: [],
        conflicts: [],
        added: fresh.map((t) => t.name),
      }

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
  const merged = { ...report.recipe, tools: report.recipe.tools.map(withConfirmIfDestructive) }
  const recipe = config.auth ? { ...merged, auth: { ...merged.auth, ...config.auth } } : merged
  return { ...report, recipe: Recipe.parse(recipe), fixtures }
}

/**
 * AC-REC-002.4, asserted where every path meets rather than where each one starts.
 *
 * `approve` injects the confirm when a destructive tool is ticked, but ticking is not the only way
 * one arrives here. `mergeRecipe` rebuilds `request.input_schema` from the fresh inference on every
 * re-record, and inference has no reason to write a confirm — so an approved destructive tool that
 * survived a re-record reached `Recipe.parse` without one and the save failed with a message the
 * user could do nothing about. A hand-promoted tool (`reclassify`) would have hit the same wall.
 * Idempotent, so the tools that already carry one are unchanged.
 */
function withConfirmIfDestructive(tool: Tool): Tool {
  if (!tool.approved || tool.side_effect !== 'destructive') return tool
  return { ...tool, request: { ...tool.request, input_schema: injectConfirm(tool.request.input_schema) } }
}

function buildRecipe(config: RecipeConfig, tools: Tool[]): Recipe {
  return Recipe.parse({
    version: RECIPE_VERSION,
    name: config.recipeName,
    enabled: true,
    target: { base_url: config.baseUrl },
    ...(config.auth !== undefined ? { auth: config.auth } : {}),
    tools,
  })
}

/**
 * The auth block a capture implies: every distinct credential the page was seen supplying, plus
 * the origin whose tab has to run the call for those credentials to be readable and for the
 * target's CORS to accept it.
 *
 * Returns undefined when the capture shows no page-supplied credential — a cookie-authenticated
 * site, where the schema default is already right.
 */
export function authFrom(exchanges: Exchange[]): Partial<Recipe['auth']> | undefined {
  type Source =
    | { kind: 'page_state'; expression: string; header?: string; param?: string; prefix: string }
    // A header the page keeps nowhere readable, so the value travels with the recipe. See
    // `CredentialSource` in @douze/shared for what that costs.
    | { kind: 'literal'; value: string; header: string; prefix: string }
  const sources = new Map<string, Source>()
  const pageOrigins = new Map<string, number>()

  for (const exchange of exchanges) {
    if (exchange.page_origin) pageOrigins.set(exchange.page_origin, (pageOrigins.get(exchange.page_origin) ?? 0) + 1)
    for (const hint of exchange.credentials ?? []) {
      // Keyed by destination: one Authorization per recipe, however many times it was observed,
      // and one parameter per expression for the values that live in the URL.
      if (hint.header) {
        const key = `header:${hint.header.toLowerCase()}`
        // A hint with a value and no expression is a header the page keeps nowhere readable; a
        // located one always wins, whichever order they were observed in.
        const literal = hint.expression === '' && hint.value !== undefined
        if (literal && !sources.has(key)) {
          sources.set(key, { kind: 'literal', value: hint.value as string, header: hint.header, prefix: hint.prefix })
        } else if (!literal && (!sources.has(key) || sources.get(key)?.kind === 'literal')) {
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
