import { parseRecipe, serializeRecipe } from '@douze/shared'
import {
  approve as approveCandidate,
  approveReads as approveReadCandidates,
  authFrom,
  baseUrlFrom,
  candidateViews,
  candidatesFrom,
  editCandidate,
  findCandidate,
  prepareSave,
  unapprove as unapproveCandidate,
  type Candidate,
  type CandidateView,
  type EditableField,
  type Fixture,
  type RecipeConfig,
} from '@douze/studio/browser'
import type { RecipeStore } from './recipes.js'
import type { CaptureStore } from './store.js'

/**
 * #ReviewSession — one finished capture turned into approved recipes, inside the extension and
 * with no daemon (T-015.3). This is douzed's `StudioSession` with extension storage where the
 * filesystem was: the review logic itself is `@douze/studio/browser`'s pure seam — inference,
 * naming, the candidate view, and `prepareSave` — none of which is reimplemented here.
 *
 * Descriptions are the deterministic ones only. `infer` writes them with `describeSync`, and the
 * model path (`describe(candidate, { model })`) is deliberately never reached: template-only
 * scores 96.4% against a ≥90% bar (Q3), so a model client is an enhancement that would buy ~4
 * points at the cost of a key, an options page, and a worker-issued fetch. A later task adds
 * exactly that — an options toggle, off by default, and a hard cap under 30 s on the fetch,
 * because a longer one is a documented service-worker kill condition.
 *
 * Cost: inference is ~55 ms for 5 000 exchanges (measured on a synthetic capture across five
 * resources), so it runs inline. Nothing here needs chunking or an alarm to survive the worker.
 */
export class ReviewSession {
  private constructor(
    private readonly config: RecipeConfig,
    private readonly recipes: RecipeStore,
    private readonly items: Candidate[],
  ) {}

  static async open(
    sessionId: string,
    stores: { captures: CaptureStore; recipes: RecipeStore },
  ): Promise<ReviewSession> {
    const detail = await stores.captures.session(sessionId)
    if (!detail) throw new Error(`no capture session "${sessionId}"`)

    // AC-EXE-001.3 — the auth block is derived from the capture, as douzed derives it. A recipe
    // left on the schema default (`cookie`) sends no credential and every call fails signed out.
    const auth = authFrom(detail.exchanges)
    const config: RecipeConfig = {
      recipeName: recipeNameFrom(detail.session.name),
      baseUrl: baseUrlFrom(detail.exchanges),
      ...(auth === undefined ? {} : { auth }),
    }
    const candidates = candidatesFrom(
      { exchanges: detail.exchanges, annotations: detail.annotations },
      auth,
    )
    return new ReviewSession(config, stores.recipes, candidates)
  }

  /** What the review page shows as its heading: the site, not the URL it was recorded from. */
  site(): string {
    try {
      return new URL(this.config.baseUrl).hostname
    } catch {
      return this.config.baseUrl
    }
  }

  recipeName(): string {
    return this.config.recipeName
  }

  candidates(): CandidateView[] {
    return candidateViews(this.items)
  }

  edit(name: string, field: EditableField, value: string): void {
    editCandidate(findCandidate(this.items, name), field, value)
  }

  approve(names: string[]): void {
    for (const name of names) approveCandidate(findCandidate(this.items, name))
  }

  unapprove(names: string[]): void {
    for (const name of names) unapproveCandidate(findCandidate(this.items, name))
  }

  /** AC-REC-002.3 — reads only; a write or a destructive tool is approved one at a time. */
  approveReads(): void {
    approveReadCandidates(this.items)
  }

  /**
   * Fixtures first, then the recipe — the order `prepareSave` documents, since `Recipe` refuses to
   * serialize an approved tool with no fixture.
   *
   * Every rule that can reject the recipe is run BEFORE the first fixture is written:
   * `prepareSave` parses it against the schema, and `serializeRecipe` + `parseRecipe` are the
   * exact pair `RecipeStore.save` will run, credential gate included. So a rejected save leaves
   * no fixtures behind. What is left is `chrome.storage` having no transaction: if a write fails
   * part way (quota), earlier fixtures stay. They are unreferenced by any recipe, so they are
   * inert, and `RecipeStore.delete` collects them with the recipe.
   */
  async save(): Promise<{ recipe: string; tools: number }> {
    const name = this.config.recipeName
    if (!this.items.some((c) => c.tool.approved)) {
      throw new Error(`nothing is approved in "${name}" — approve at least one tool before saving`)
    }

    const prepared = prepareSave(this.config, this.items, this.recipes.recipe(name), await this.storedFixtures())
    const yaml = serializeRecipe(prepared.recipe)
    const validated = parseRecipe(yaml, name)
    if (!validated.ok || !validated.recipe) throw new Error(validated.error ?? `${name}: recipe rejected`)

    for (const { fixture } of prepared.fixtures) await this.recipes.putFixture(name, fixture.tool, fixture)
    const saved = await this.recipes.save(yaml, name)
    if (!saved.ok || !saved.recipe) throw new Error(saved.error ?? `${name}: recipe rejected`)
    return { recipe: name, tools: saved.recipe.tools.filter((tool) => tool.approved).length }
  }

  /** AC-REC-003.3 — the fixtures already stored, so re-inference can spot a schema change. */
  private async storedFixtures(): Promise<Record<string, Fixture[]>> {
    const out: Record<string, Fixture[]> = {}
    for (const stored of Object.values(await this.recipes.fixtures(this.config.recipeName))) {
      const fixture = stored as Fixture | undefined
      if (fixture?.tool !== undefined) (out[fixture.tool] ??= []).push(fixture)
    }
    return out
  }
}

/**
 * The capture's name as a recipe name. `Recipe` requires kebab-case starting with a letter, so a
 * session named "2026 audit" is prefixed rather than failing at save time — the user named a
 * recording, not a recipe.
 */
function recipeNameFrom(sessionName: string): string {
  const slug = sessionName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return /^[a-z]/.test(slug) ? slug : `recipe-${slug}`
}
