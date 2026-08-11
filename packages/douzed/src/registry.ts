import { EventEmitter, once } from 'node:events'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import watch from 'chokidar'
import { Recipe, Tool, parseRecipe, type CredentialSource } from '@douze/shared'

/** One entry of the Tool Surface: a tool plus the recipe it came from. */
export interface SurfaceTool {
  /** AC-RUN-001.2 — `<recipe>_<tool>` over MCP, `douze <recipe> <tool>` in the CLI. */
  qualified_name: string
  recipe: string
  base_url: string
  tool: Tool
  /** AC-EXE-001.3 — descriptor only; the extension resolves the actual value at call time. */
  credential_source: CredentialSource[]
  /** The origin whose tab runs the call; absent means the target's own. */
  page_origin?: string
  /** AC-RUN-001.5 — exposed but rejected at call time, with the reason named. */
  degraded: boolean
  degraded_reason?: string
}

/**
 * The minimum a request builder needs about a tool. Structural so one builder serves the relay,
 * headless mode, and an ejected package alike (AC-EJT-002.1).
 */
export interface SurfaceToolLike {
  base_url: string
  tool: Pick<Tool, 'request'>
  credential_source?: CredentialSource[]
  page_origin?: string
}

export interface RegistryState {
  tools: SurfaceTool[]
  /** AC-REC-001.4 — failures reported by recipe name, never silently swallowed. */
  errors: { recipe: string; error: string }[]
  /** Monotonic; a client compares this to know the surface moved. */
  revision: number
}

/**
 * #RecipeRegistry — owns the only mutable shared state in the runtime. Loads enabled recipes,
 * validates them, watches the directory, and keeps the last valid version of a recipe whose
 * reload failed (AC-RUN-002.3).
 */
export class RecipeRegistry extends EventEmitter {
  /** Last successfully-loaded version per file, so a bad edit cannot take a recipe down. */
  private readonly loaded = new Map<string, Recipe>()
  private readonly errors = new Map<string, string>()
  /** Fixture validity keyed by path, invalidated by mtime+size. */
  private readonly fixtureCache = new Map<string, { stamp: string; error: string | null }>()
  private watcher?: ReturnType<typeof watch.watch>
  private revision = 0

  constructor(
    private readonly dir: string,
    private readonly fixturesDir: string,
  ) {
    super()
  }

  /**
   * Resolves once the watcher is live. On macOS, fsevents delivers nothing for the window
   * between `watch()` and 'ready', so a recipe written in that gap was simply never seen —
   * invisible until some later edit happened to touch the directory again. Awaiting 'ready'
   * closes the window, and the second load picks up whatever landed while it was open.
   */
  async start(): Promise<void> {
    this.loadAll()
    // AC-RUN-002.1 — an edit must reach the surface within 5 seconds; 250ms of write-settling
    // is well inside that and avoids reloading a half-written file.
    this.watcher = watch.watch(this.dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    })
    for (const event of ['add', 'change', 'unlink'] as const) {
      this.watcher.on(event, (path: string) => {
        if (!path.endsWith('.yaml') && !path.endsWith('.yml')) return
        this.loadAll()
      })
    }
    await once(this.watcher, 'ready')
    this.loadAll()
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
  }

  private loadAll(): void {
    if (!existsSync(this.dir)) return
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    const before = JSON.stringify(this.state().tools)

    // A file that disappeared should stop being served.
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before mutating the collection being iterated
    for (const known of [...this.loaded.keys()]) if (!files.includes(known)) this.loaded.delete(known)
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before mutating the collection being iterated
    for (const known of [...this.errors.keys()]) if (!files.includes(known)) this.errors.delete(known)

    for (const file of files) {
      const result = parseRecipe(readFileSync(join(this.dir, file), 'utf8'), file)
      if (result.ok && result.recipe) {
        this.loaded.set(file, result.recipe)
        this.errors.delete(file)
        if (result.migrated?.length) {
          // AC-REC-001.3 — report every field a migration altered.
          this.emit('migrated', { recipe: result.recipe.name, fields: result.migrated })
        }
      } else {
        // AC-RUN-002.3 — keep serving whatever last parsed; only record the error.
        this.errors.set(file, result.error ?? 'unknown error')
      }
    }

    if (JSON.stringify(this.state().tools) !== before) {
      this.revision += 1
      this.emit('changed', this.state())
    }
  }

  state(): RegistryState {
    const tools: SurfaceTool[] = []
    for (const recipe of this.loaded.values()) {
      // AC-RUN-001.4 — a disabled recipe stays loaded for `doctor` but exposes nothing.
      if (!recipe.enabled) continue
      for (const tool of recipe.tools) {
        // AC-REC-002.5 — unapproved candidates are never exposed.
        if (!tool.approved) continue
        const fixtureIssue = this.validateFixtures(tool)
        // A tool degrades either because a Doctor Run flagged it or because its fixture no
        // longer loads; whichever applies supplies the reason the caller sees.
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
    return {
      tools,
      errors: [...this.errors.entries()].map(([recipe, error]) => ({ recipe, error })),
      revision: this.revision,
    }
  }

  /** All recipes including disabled ones — `doctor` needs these (AC-RUN-001.4). */
  recipes(): Recipe[] {
    return [...this.loaded.values()]
  }

  recipe(name: string): Recipe | null {
    return this.recipes().find((r) => r.name === name) ?? null
  }

  /**
   * A recipe's `name` need not match its filename, so anything writing a recipe back must ask
   * where it came from — otherwise it creates a second file defining the same recipe name.
   */
  fileFor(recipeName: string): string | null {
    for (const [file, recipe] of this.loaded) if (recipe.name === recipeName) return file
    return null
  }

  /**
   * AC-RUN-001.5 — a fixture that no longer matches its tool's declared schema degrades the
   * tool rather than removing it, and the failing fixture is named.
   *
   * Cached by (file, mtime, size): `state()` runs on every `/registry` request AND every relay
   * call, and re-reading every fixture from disk each time is real latency against the <150ms
   * per-call target. The mtime key means an edited fixture is still picked up immediately.
   */
  private validateFixtures(tool: Tool): string | null {
    for (const fixture of tool.fixtures) {
      const path = join(this.fixturesDir, fixture)
      let stamp: string
      try {
        const stats = statSync(path)
        stamp = `${stats.mtimeMs}:${stats.size}`
      } catch {
        return `fixture "${fixture}" is missing`
      }

      const cached = this.fixtureCache.get(path)
      if (cached?.stamp === stamp) {
        if (cached.error) return cached.error
        continue
      }

      let error: string | null = null
      try {
        JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        error = `fixture "${fixture}" is not valid JSON`
      }
      this.fixtureCache.set(path, { stamp, error })
      if (error) return error
    }
    return null
  }
}
