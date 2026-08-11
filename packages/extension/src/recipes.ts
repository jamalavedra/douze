import {
  findSurvivingSecrets,
  parseRecipe,
  serializeRecipe,
  type CredentialSource,
  type LoadResult,
  type Recipe,
  type Tool,
} from '@douze/shared'

/**
 * #RecipeStore — recipes and fixtures in extension storage, replacing douzed's `~/.douze/recipes`
 * directory and its RecipeRegistry (T-015.2). Same schema, same validation, same tool surface;
 * `chrome.storage.onChanged` takes the file watcher's place.
 *
 * Storage: `chrome.storage.local`, NOT the IndexedDB the capture store uses. Two reasons.
 * `storage.onChanged` is the hot-reload signal and it fires across every extension context —
 * a recipe approved on the review page reaches the service worker's surface with no plumbing,
 * where IndexedDB has no change event at all and would need a BroadcastChannel invented next to
 * it. And the volume is small: a recipe is a few KB of YAML and a fixture is ONE redacted
 * exchange per approved tool, so a busy install is single-digit MB against the 10 MB quota —
 * `unlimitedStorage` (which T-015.1's manifest already requests for capture) lifts that anyway.
 * Capture data is the opposite shape — tens of MB of response bodies, needing ordered range
 * scans — which is exactly why THAT lives in IndexedDB and this does not.
 *
 * A recipe is stored as its YAML source, not as a parsed object: it is the same bytes the daemon
 * kept on disk, so export is the stored string and a round-trip cannot drift, comments and key
 * order included. The key is the recipe's own name, which retires the daemon's `fileFor()` — a
 * recipe can no longer be defined by a file whose name disagrees with it.
 */

const RECIPE_PREFIX = 'recipe:'
const FIXTURE_PREFIX = 'fixture:'

/** One entry of the Tool Surface: a tool plus the recipe it came from. */
export interface SurfaceTool {
  /** AC-RUN-001.2 — `<recipe>_<tool>` over MCP. */
  qualified_name: string
  recipe: string
  base_url: string
  tool: Tool
  /** AC-EXE-001.3 — descriptor only; the value is resolved from the page at call time. */
  credential_source: CredentialSource[]
  /** The origin whose tab runs the call; absent means the target's own. */
  page_origin?: string
  /** AC-RUN-001.5 — exposed but rejected at call time, with the reason named. */
  degraded: boolean
  degraded_reason?: string
}

export interface RegistryState {
  tools: SurfaceTool[]
  /** AC-REC-001.4 — failures reported by recipe name, never silently swallowed. */
  errors: { recipe: string; error: string }[]
  /** Monotonic; a client compares this to know the surface moved. */
  revision: number
}

/**
 * One file of an export, laid out as `~/.douze` lays it out: `recipes/<name>.yaml` and
 * `fixtures/<recipe>/<tool>.json`. A recipe file is byte-for-byte what the daemon reads, so it
 * can be dropped straight into `~/.douze/recipes`, and a file taken from there imports here.
 */
export interface ExportedFile {
  path: string
  content: string
}

export interface ImportResult {
  /** False leaves storage untouched — the whole import is validated before anything is written. */
  ok: boolean
  /** Recipe names written. */
  imported: string[]
  /** Fixture references written. */
  fixtures: string[]
  /** AC-REC-003 — names already present; re-run with `overwrite` to take them. */
  conflicts: string[]
  errors: string[]
}

export class RecipeStore {
  /** Last successfully-parsed version per name, so a bad record cannot take a recipe down. */
  private readonly loaded = new Map<string, Recipe>()
  private readonly errors = new Map<string, string>()
  /** Fixture references present in storage. Existence is the whole check — see validateFixtures. */
  private fixturePresent = new Set<string>()
  private readonly subscribers = new Set<(state: RegistryState) => void>()
  private cached: RegistryState = { tools: [], errors: [], revision: 0 }
  private revision = 0
  private listener?: Parameters<typeof chrome.storage.onChanged.addListener>[0]

  private constructor() {}

  static async open(): Promise<RecipeStore> {
    const store = new RecipeStore()
    // AC-RUN-002.1 — an approval anywhere in the extension reaches the surface immediately;
    // `storage.onChanged` is the same signal the daemon got from chokidar, minus the debounce
    // (a `set` is atomic, so there is no half-written record to wait out).
    //
    // The listener goes on BEFORE the first read, not after: a write landing between the two would
    // otherwise be missed by the read (too early) and by the listener (not yet attached), leaving a
    // surface that is stale until the next unrelated write. Refreshing twice at startup is free.
    store.listener = (changes, area): void => {
      if (area !== 'local') return
      if (!Object.keys(changes).some(isOurs)) return
      void store.refresh()
    }
    chrome.storage.onChanged.addListener(store.listener)
    await store.refresh()
    return store
  }

  close(): void {
    if (this.listener) chrome.storage.onChanged.removeListener(this.listener)
    this.subscribers.clear()
  }

  /** The Tool Surface as of the last load. Synchronous, as the daemon's `state()` was. */
  surface(): RegistryState {
    return this.cached
  }

  /** Fires when the surface moves. Returns the unsubscribe. */
  subscribe(handler: (state: RegistryState) => void): () => void {
    this.subscribers.add(handler)
    return () => this.subscribers.delete(handler)
  }

  /** All recipes including disabled ones — `doctor` and the review UI need those. */
  recipes(): Recipe[] {
    return [...this.loaded.values()]
  }

  recipe(name: string): Recipe | null {
    return this.loaded.get(name) ?? null
  }

  /**
   * The only write path for a recipe. Validation is `parseRecipe` — the same function the daemon
   * ran on a file, credential gate included — so an invalid recipe never reaches storage and the
   * version already there keeps serving (AC-RUN-002.3).
   *
   * `name` identifies the recipe in `surface().errors` when the source is too broken to parse a
   * name out of; when it parses, the recipe's own name always wins and is what it is stored under.
   */
  async save(source: string | Recipe, name?: string): Promise<LoadResult> {
    const yaml = typeof source === 'string' ? source : serializeRecipe(source)
    const label = name ?? (typeof source === 'string' ? '<unnamed>' : source.name)
    const result = parseRecipe(yaml, label)
    if (!result.ok || !result.recipe) {
      // AC-REC-001.4 — reported by name. Cleared by the next successful load of that recipe:
      // the rejected text was never stored, so there is nothing on the way in to keep failing.
      this.errors.set(label, result.error ?? 'unknown error')
      this.recompute()
      return result
    }
    await chrome.storage.local.set({ [RECIPE_PREFIX + result.recipe.name]: yaml })
    // `storage.onChanged` will fire too, but it is delivered after this call returns and a caller
    // that just awaited a save must not read a stale surface. The second refresh is a no-op.
    await this.refresh()
    return result
  }

  /** The recipe and every fixture recorded under it. */
  async delete(name: string): Promise<void> {
    const references = [...this.fixturePresent].filter((r) => r.startsWith(`${name}/`))
    await chrome.storage.local.remove([RECIPE_PREFIX + name, ...references.map((r) => FIXTURE_PREFIX + r)])
    await this.refresh()
  }

  /**
   * REQ-REC-004 — a redacted exchange stored beside its recipe. Returns the reference to put in
   * `tool.fixtures`, in the daemon's `<recipe>/<tool>.json` form.
   *
   * TR-6 — the shape gate runs here as it does on every other write: a fixture is a real response
   * body, and one carrying a live token is the exact thing that must not be persisted.
   */
  async putFixture(recipe: string, tool: string, fixture: unknown): Promise<string> {
    const reference = `${recipe}/${tool}.json`
    await chrome.storage.local.set({ [FIXTURE_PREFIX + reference]: this.gate(reference, fixture) })
    await this.refresh()
    return reference
  }

  async fixture(reference: string): Promise<unknown> {
    const stored = await chrome.storage.local.get(FIXTURE_PREFIX + reference)
    return stored[FIXTURE_PREFIX + reference] ?? null
  }

  /** Every fixture of one recipe, keyed by reference. */
  async fixtures(recipe: string): Promise<Record<string, unknown>> {
    const references = [...this.fixturePresent].filter((r) => r.startsWith(`${recipe}/`)).sort()
    const stored = await chrome.storage.local.get(references.map((r) => FIXTURE_PREFIX + r))
    return Object.fromEntries(references.map((r) => [r, stored[FIXTURE_PREFIX + r]]))
  }

  /** The recipe's YAML plus its fixtures, as files. */
  async exportRecipe(name: string): Promise<ExportedFile[]> {
    const stored = await chrome.storage.local.get(RECIPE_PREFIX + name)
    const yaml = stored[RECIPE_PREFIX + name] as string | undefined
    if (yaml === undefined) throw new Error(`no such recipe: ${name}`)
    const fixtures = await this.fixtures(name)
    return [
      { path: `recipes/${name}.yaml`, content: yaml },
      ...Object.entries(fixtures).map(([reference, fixture]) => ({
        path: `fixtures/${reference}`,
        // Two-space JSON with a trailing newline, exactly as douzed wrote it.
        content: `${JSON.stringify(fixture, null, 2)}\n`,
      })),
    ]
  }

  async exportAll(): Promise<ExportedFile[]> {
    const files: ExportedFile[] = []
    for (const name of [...this.loaded.keys()].sort()) files.push(...(await this.exportRecipe(name)))
    return files
  }

  /**
   * Import is `save` for every recipe in the set — the same `parseRecipe`, so a recipe carrying a
   * credential value is refused here too. Nothing is written unless the whole set validates and
   * no name collides, so a rejected import cannot leave half a recipe behind.
   */
  async importFiles(files: ExportedFile[], options: { overwrite?: boolean } = {}): Promise<ImportResult> {
    const result: ImportResult = { ok: false, imported: [], fixtures: [], conflicts: [], errors: [] }
    const writes: Record<string, unknown> = {}

    for (const file of files) {
      if (file.path.endsWith('.yaml') || file.path.endsWith('.yml')) {
        const parsed = parseRecipe(file.content, file.path)
        if (!parsed.ok || !parsed.recipe) {
          result.errors.push(parsed.error ?? `${file.path}: unknown error`)
          continue
        }
        const name = parsed.recipe.name
        if (this.loaded.has(name) && !options.overwrite) result.conflicts.push(name)
        else {
          writes[RECIPE_PREFIX + name] = file.content
          result.imported.push(name)
        }
        continue
      }
      if (!file.path.endsWith('.json')) {
        result.errors.push(`${file.path}: not a recipe or a fixture`)
        continue
      }
      // A file picked out of `~/.douze/fixtures` arrives as `<recipe>/<tool>.json` already; one
      // from an export of ours carries the directory it was exported into.
      const reference = file.path.startsWith('fixtures/') ? file.path.slice('fixtures/'.length) : file.path
      try {
        writes[FIXTURE_PREFIX + reference] = this.gate(reference, JSON.parse(file.content))
        result.fixtures.push(reference)
      } catch (cause) {
        result.errors.push(`${file.path}: ${(cause as Error).message}`)
      }
    }

    if (result.errors.length > 0 || result.conflicts.length > 0) return result
    await chrome.storage.local.set(writes)
    await this.refresh()
    return { ...result, ok: true }
  }

  /** Re-reads storage and republishes the surface. Called on open and on every relevant change. */
  private async refresh(): Promise<void> {
    const keys = await chrome.storage.local.getKeys()
    const recipeKeys = keys.filter((key) => key.startsWith(RECIPE_PREFIX))
    this.fixturePresent = new Set(
      keys.filter((key) => key.startsWith(FIXTURE_PREFIX)).map((key) => key.slice(FIXTURE_PREFIX.length)),
    )
    const names = recipeKeys.map((key) => key.slice(RECIPE_PREFIX.length))
    const stored = await chrome.storage.local.get(recipeKeys)

    // A recipe that was deleted should stop being served.
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before mutating the collection being iterated
    for (const known of [...this.loaded.keys()]) if (!names.includes(known)) this.loaded.delete(known)
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before mutating the collection being iterated
    for (const known of [...this.errors.keys()]) if (!names.includes(known)) this.errors.delete(known)

    for (const name of names) {
      const result = parseRecipe(String(stored[RECIPE_PREFIX + name]), name)
      if (result.ok && result.recipe) {
        this.loaded.set(name, result.recipe)
        this.errors.delete(name)
      } else {
        // AC-RUN-002.3 — keep serving whatever last parsed; only record the error.
        this.errors.set(name, result.error ?? 'unknown error')
      }
    }
    this.recompute()
  }

  private recompute(): void {
    const tools = this.computeTools()
    // Errors alone do not move the surface, exactly as in douzed: `revision` answers "is the set
    // of callable tools the one I already have", and a rejected edit does not change that.
    const changed = JSON.stringify(tools) !== JSON.stringify(this.cached.tools)
    if (changed) this.revision += 1
    this.cached = {
      tools,
      errors: [...this.errors.entries()].map(([recipe, error]) => ({ recipe, error })),
      revision: this.revision,
    }
    if (changed) for (const handler of this.subscribers) handler(this.cached)
  }

  private computeTools(): SurfaceTool[] {
    const tools: SurfaceTool[] = []
    for (const recipe of this.loaded.values()) {
      // AC-RUN-001.4 — a disabled recipe stays loaded for `doctor` but exposes nothing.
      if (!recipe.enabled) continue
      for (const tool of recipe.tools) {
        // AC-REC-002.5 — unapproved candidates are never exposed.
        if (!tool.approved) continue
        const fixtureIssue = this.validateFixtures(tool)
        const reason = tool.flags.degraded_reason ?? fixtureIssue ?? undefined
        tools.push({
          // AC-RUN-001.3 — the namespace keeps same-named tools from two recipes distinct.
          qualified_name: `${recipe.name}_${tool.name}`,
          recipe: recipe.name,
          base_url: recipe.target.base_url,
          tool,
          credential_source: recipe.auth.credential_source,
          ...(recipe.auth.page_origin === undefined ? {} : { page_origin: recipe.auth.page_origin }),
          degraded: tool.flags.degraded || fixtureIssue !== null,
          ...(reason === undefined ? {} : { degraded_reason: reason }),
        })
      }
    }
    return tools
  }

  /**
   * AC-RUN-001.5 — a tool whose fixture is gone degrades rather than disappearing, and the
   * missing fixture is named. Presence is the whole check: a stored fixture went through
   * `JSON.parse` on the way in, so douzed's "not valid JSON" case — and the mtime cache it
   * needed to avoid re-reading every fixture from disk per call — cannot arise here.
   */
  private validateFixtures(tool: Tool): string | null {
    for (const fixture of tool.fixtures) {
      if (!this.fixturePresent.has(fixture)) return `fixture "${fixture}" is missing`
    }
    return null
  }

  /** AC-REC-004.2 / TR-6 — a fixture carrying a credential-shaped value is refused, not stored. */
  private gate(reference: string, fixture: unknown): unknown {
    const leaked = findSurvivingSecrets(fixture)
    if (leaked.length > 0) {
      throw new Error(`refusing to store fixture "${reference}": credential at ${leaked.join(', ')}`)
    }
    return fixture
  }
}

const isOurs = (key: string): boolean => key.startsWith(RECIPE_PREFIX) || key.startsWith(FIXTURE_PREFIX)
