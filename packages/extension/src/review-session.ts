import { MAX_NAME, parseRecipe, serializeRecipe, type Exchange, type Recipe, type Tool } from '@douze/shared'
import {
  approve as approveCandidate,
  authFrom,
  baseUrlFrom,
  candidateViews,
  candidatesFrom,
  editCandidate,
  findCandidate,
  fixtureReference,
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
 *
 * **AC-REC-002.3 is a UI default here, not a server-side rule, and that is deliberate.** douzed
 * had two approval routes — `enable <name>` and a bulk `approveReads()` that took no arguments —
 * so "bulk-enable is reads-only" could be enforced in the one that named nothing. The extension
 * has a single route: `douze:review:enable` carries the names, and every name in it is a tick box
 * the user set on the review page. There is no unnamed bulk path left to constrain, and a
 * surviving `approveReads()` with no caller would advertise an enforcement point nothing reaches,
 * so it was removed rather than kept as decoration. What still holds the line is the review page's
 * seed — `bulk_approvable`, which is reads — so nothing a user has not read is selected for them;
 * `pages.test.ts` pins that. The sender check in background.ts keeps the route inside our own
 * pages either way.
 */
export class ReviewSession {
  private constructor(
    private readonly config: RecipeConfig,
    private readonly recipes: RecipeStore,
    private readonly items: Candidate[],
    /**
     * True when the candidates ARE the stored recipe's own tools (`openRecipe`) rather than a
     * fresh inference over a capture. `mergeRecipe` exists to protect what is stored from being
     * clobbered by re-inference, and merging a recipe against itself is not that: `mergeTool`
     * keeps `approved` from the stored side, so every tick the reader just made would be merged
     * straight back out again.
     */
    private readonly fromRecipe = false,
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
    const baseUrl = baseUrlFrom(detail.exchanges)
    const config: RecipeConfig = {
      recipeName: unclaimedName(recipeNameFrom(detail.session.name, detail.session.origins[0]), baseUrl, stores.recipes),
      baseUrl,
      ...(auth === undefined ? {} : { auth }),
    }
    const candidates = candidatesFrom(
      { exchanges: detail.exchanges, annotations: detail.annotations },
      auth,
    )
    return new ReviewSession(config, stores.recipes, candidates)
  }

  /**
   * The same review, for a recipe that arrived as a FILE rather than as a recording.
   *
   * `RecipeStore.importFiles` now lands every imported tool unapproved whatever the file claimed,
   * which left an imported recipe inert with nowhere to go: every review route named a capture
   * session, and an imported recipe has no capture behind it. This is that route. It is the same
   * page, the same tick boxes and the same `save()` — approving an imported tool is exactly as
   * much work, and exactly as much reading, as approving a recorded one.
   *
   * The evidence each candidate shows is the fixture the file shipped, which is what a fixture
   * already is: one real, redacted exchange. A tool with no fixture still appears, showing the
   * request it would make and an empty response — that is genuinely all that is known about it,
   * and hiding it would be worse than saying so.
   *
   * There is no inference here and there cannot be: inference reads exchanges, and a file supplies
   * assertions. So what the reader is shown is the file's own words. They are editable on the same
   * page, and the recipe is stored before any of this — nothing here can be approved without
   * having passed `parseRecipe`, credential gate, mutation check and description cap included.
   */
  static async openRecipe(name: string, stores: { recipes: RecipeStore }): Promise<ReviewSession> {
    const recipe = stores.recipes.recipe(name)
    if (!recipe) throw new Error(`no recipe "${name}"`)
    const fixtures = await stores.recipes.fixtures(name)
    // Cloned: `recipe` is the store's own cached parse, and approving a candidate mutates the tool.
    const items = structuredClone(recipe.tools).map((tool) => ({
      tool,
      evidence: {
        exchange_ids: [],
        sample: sampleFrom(recipe, tool, fixtures[fixtureReference(name, tool.name)] as Fixture | undefined),
      },
    }))
    return new ReviewSession(
      { recipeName: name, baseUrl: recipe.target.base_url, auth: recipe.auth },
      stores.recipes,
      items,
      true,
    )
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

    const existing = this.fromRecipe ? null : this.recipes.recipe(name)
    const prepared = prepareSave(this.config, this.items, existing, await this.storedFixtures())
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
 * The one exchange a stored recipe knows about, which is its fixture — `toFixture` turned an
 * exchange into it on the way in, and `prepareSave` turns this back into a fixture on the way out,
 * re-redacting as it goes. A tool that shipped without a fixture gets the request its own recipe
 * describes and an empty response, so the review page shows what it would do rather than nothing.
 */
function sampleFrom(recipe: Recipe, tool: Tool, fixture: Fixture | undefined): Exchange {
  const request = fixture?.request
  const response = fixture?.response
  return {
    id: '',
    session_id: '',
    position: 0,
    started_at: fixture ? Date.parse(fixture.recorded_at) : Date.now(),
    duration_ms: 0,
    method: request?.method ?? tool.request.method,
    url: request?.url ?? new URL(tool.request.path, recipe.target.base_url).toString(),
    origin: new URL(recipe.target.base_url).origin,
    request_headers: request?.headers ?? {},
    ...(request?.body === undefined ? {} : { request_body: request.body }),
    status: response?.status ?? 0,
    response_headers: response?.headers ?? {},
    ...(response?.body === undefined ? {} : { response_body: response.body }),
    body_missing: false,
    background: false,
    source: 'har',
    credentials: [],
  }
}

/**
 * The capture's name as a recipe name. `Recipe` requires kebab-case starting with a letter and no
 * more than MAX_NAME characters, so a session named "2026 audit" is prefixed rather than failing
 * at save time — the user named a recording, not a recipe.
 *
 * Three things the plain slug got wrong, all of them only visible after a recording was finished
 * and reviewed, when saving threw "recipe rejected" or produced a name nobody recognised:
 *
 *  - Accents were dropped mid-word rather than folded, so "Hoja de cálculo" became
 *    `hoja-de-c-lculo`. NFD and stripping the combining marks gives `hoja-de-calculo`.
 *  - A name in a non-Latin script slugged to nothing and came out as `recipe-`, so every such
 *    capture collided on one recipe. The origin is the fallback, because it is what the popup
 *    offers when the name is left blank and it at least names the site.
 *  - Nothing was truncated, so any name over MAX_NAME characters recorded fine and then failed
 *    validation at save, with the work already done.
 */
function recipeNameFrom(sessionName: string, origin?: string): string {
  const slug = slugify(sessionName) || (origin === undefined ? '' : slugify(hostOf(origin)))
  const named = /^[a-z]/.test(slug) ? slug : `recipe-${slug}`
  // Trailing hyphens again: the slice can land on one, and `recipe-` with an empty slug is one.
  return named.slice(0, MAX_NAME).replace(/-+$/, '')
}

function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A recipe name that will not merge this capture into a different site's recipe.
 *
 * Saving into an existing recipe keeps THAT recipe's target — `mergeRecipe` builds on it, and
 * `config.baseUrl` is only read when there is no existing recipe — so two captures a user happened
 * to name the same thing, "Work" or "Admin", became one recipe whose tools all pointed at whichever
 * site was recorded first. The second site's tools then ran against the first site's host carrying
 * the second site's credentials, which is a request nobody asked for sent somewhere it should
 * never go.
 *
 * Re-recording the SAME site must still merge — that is what makes a stable name useful — so the
 * test is the target, not the name. The disambiguator is the host, because it is the thing that
 * actually differs; the counter after it exists only for two origins on one host, like a staging
 * port, and giving up loudly beats merging quietly.
 */
function unclaimedName(preferred: string, baseUrl: string, recipes: RecipeStore): string {
  const claimedByAnother = (name: string): boolean => {
    const existing = recipes.recipe(name)
    return existing !== null && existing !== undefined && existing.target.base_url !== baseUrl
  }
  if (!claimedByAnother(preferred)) return preferred
  // The suffix is trimmed off the PREFERRED half, never the suffix: clamping the whole string
  // would truncate the very thing that makes it distinct and hand back `preferred` again.
  const withSuffix = (suffix: string): string =>
    `${preferred.slice(0, Math.max(1, MAX_NAME - suffix.length - 1))}-${suffix}`.replace(/-+$/, '')
  const host = slugify(hostOf(baseUrl))
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = withSuffix(attempt === 0 ? host : `${host}-${attempt + 1}`)
    if (!claimedByAnother(name)) return name
  }
  throw new Error(
    `every name based on "${preferred}" is already used by a different site. ` +
      `Delete or rename the recipe called "${preferred}", then review this capture again.`,
  )
}

/** The host alone, so a fallback name is `jira-example-com` rather than `https-jira-example-com`. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}
