import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DouzeError, Recipe, serializeRecipe, type DriftStatus, type Tool } from '@douze/shared'
import type { RecipeRegistry, SurfaceTool } from './registry.js'
import type { RelayBridge } from './relay.js'

const run = promisify(execFile)

/** Infrastructure failed, so this run learned nothing about the target's contract. */
export class TransientDriftError extends Error {}

export interface ToolReport {
  tool: string
  status: DriftStatus
  detail?: string
  /** AC-DRF-003.1 — the optional fields a widening patch would add. */
  added_fields?: string[]
}

export interface DoctorReport {
  recipe: string
  at: string
  tools: ToolReport[]
  patched: boolean
}

/**
 * #DriftWatcher — replays read-only fixtures against the live target, classifies the outcome,
 * and writes degradation into the recipe so it propagates to every client through the same
 * hot-reload path as any other edit (AC-DRF-002.1). It has no client-facing mechanism of its own.
 */
export class DriftWatcher {
  private timer?: NodeJS.Timeout

  constructor(
    private readonly registry: RecipeRegistry,
    private readonly bridge: RelayBridge,
    private readonly recipesDir: string,
    private readonly fixturesDir: string,
    private readonly options: { webhook?: string; intervalMs?: number; commitPatches?: boolean } = {},
  ) {}

  /** AC-DRF-001.3 — runs on a schedule and skips silently when the relay is unavailable. */
  schedule(): void {
    const interval = this.options.intervalMs ?? 6 * 60 * 60 * 1000
    this.timer = setInterval(() => {
      if (!this.bridge.connected) return
      for (const recipe of this.registry.recipes()) void this.run(recipe.name).catch(() => undefined)
    }, interval)
    this.timer.unref?.()
  }

  stop(): void {
    clearInterval(this.timer)
  }

  async run(recipeName: string): Promise<DoctorReport> {
    const recipe = this.registry.recipe(recipeName)
    if (!recipe) throw new Error(`no recipe "${recipeName}"`)

    const reports: ToolReport[] = []
    let mutated = false

    for (const tool of recipe.tools) {
      if (!tool.approved) continue
      // AC-DRF-001.1 — write and destructive fixtures are NEVER replayed.
      if (tool.side_effect !== 'read') continue

      let report: ToolReport
      try {
        report = await this.replay(recipe, tool)
      } catch (error) {
        // AC-DRF-001.3 — infrastructure gave out mid-run. Abandon the run rather than write
        // conclusions about a target we never actually reached.
        if (error instanceof TransientDriftError) {
          throw new Error(`doctor run for "${recipe.name}" abandoned: ${error.message}`)
        }
        throw error
      }
      reports.push(report)

      if (report.status === 'breaking' || report.status === 'gone') {
        // AC-DRF-002.1 — degradation is written into the recipe, not held in memory.
        tool.flags.degraded = true
        tool.flags.degraded_reason = report.detail ?? report.status
        mutated = true
      } else if (report.status === 'ok' && tool.flags.degraded) {
        tool.flags.degraded = false
        delete tool.flags.degraded_reason
        mutated = true
      } else if (report.status === 'schema_widened' && report.added_fields?.length) {
        // AC-DRF-003.1 — add the new fields as OPTIONAL and change nothing else.
        widenSchema(tool, report.added_fields)
        mutated = true
      }
    }

    if (mutated) {
      // Write back to the file this recipe was LOADED from; its name need not match its filename.
      const file = this.registry.fileFor(recipe.name) ?? `${recipe.name}.yaml`
      writeFileSync(join(this.recipesDir, file), serializeRecipe(Recipe.parse(recipe)))
      await this.commitPatch(file)
    }

    const report: DoctorReport = { recipe: recipe.name, at: new Date().toISOString(), tools: reports, patched: mutated }

    // AC-DRF-003.3 — notify when anything is broken or gone.
    if (reports.some((r) => r.status === 'breaking' || r.status === 'gone')) await this.notify(report)

    return report
  }

  private async replay(recipe: Recipe, tool: Tool): Promise<ToolReport> {
    const fixture = this.loadFixture(tool)
    if (!fixture) return { tool: tool.name, status: 'gone', detail: 'no fixture stored to replay' }

    const surface: SurfaceTool = {
      qualified_name: `${recipe.name}_${tool.name}`,
      recipe: recipe.name,
      base_url: recipe.target.base_url,
      tool,
      credential_source: recipe.auth.credential_source,
      degraded: false,
    }

    let live: unknown
    try {
      const response = await this.bridge.call(surface, fixture.args ?? {})
      if (response.status === 404 || response.status === 410) {
        return { tool: tool.name, status: 'gone', detail: `target returned ${response.status}` }
      }
      live = response.body
    } catch (error) {
      // Classify on the error CODE, never on message text. An extension that disconnected or a
      // call that timed out says nothing about the target's contract — treating those as
      // `breaking` would permanently degrade every tool in every recipe over a transient blip.
      if (error instanceof DouzeError) {
        if (error.code === 'session_expired') {
          return { tool: tool.name, status: 'session_expired', detail: error.message }
        }
        throw new TransientDriftError(error.message)
      }
      return { tool: tool.name, status: 'breaking', detail: (error as Error).message }
    }

    return compare(tool.name, fixture.response, live)
  }

  private loadFixture(tool: Tool): { args?: Record<string, unknown>; response: unknown } | null {
    const name = tool.fixtures[0]
    if (!name) return null
    const path = join(this.fixturesDir, name)
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      // A fixture is either a bare response body or {args, response}.
      return 'response' in raw ? raw : { response: raw }
    } catch {
      return null
    }
  }

  /**
   * AC-DRF-003.2 — *offer* to commit. Opt-in only: a background drift run must never move the
   * user's HEAD onto a branch, sweep up their staged work, or race another run in the same repo.
   * When enabled, the original branch is restored and only the recipe file is committed.
   */
  private async commitPatch(file: string): Promise<void> {
    if (!this.options.commitPatches) return
    try {
      await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.recipesDir })
    } catch {
      return
    }

    let original: string
    try {
      original = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.recipesDir })).stdout.trim()
    } catch {
      return
    }

    const branch = `douze/drift-${file.replace(/\.ya?ml$/, '')}`
    try {
      await run('git', ['checkout', '-B', branch], { cwd: this.recipesDir })
      // A pathspec commit touches only this file, leaving anything the user had staged alone.
      await run('git', ['commit', '-m', `douze: drift patch for ${file}`, '--', file], { cwd: this.recipesDir })
    } catch {
      // Nothing to commit, or a hook refused — the recipe is already written either way.
    } finally {
      await run('git', ['checkout', original], { cwd: this.recipesDir }).catch(() => undefined)
    }
  }

  private async notify(report: DoctorReport): Promise<void> {
    if (!this.options.webhook) return
    try {
      await fetch(this.options.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      })
    } catch {
      // A failed webhook must not fail the run.
    }
  }
}

/**
 * AC-DRF-001.2 — the five-way classification. A field that appeared is a widening; a field that
 * vanished or changed type is breaking.
 */
export function compare(toolName: string, expected: unknown, live: unknown): ToolReport {
  const missing: string[] = []
  const added: string[] = []
  const retyped: string[] = []
  walk(expected, live, '$', missing, added, retyped)

  if (missing.length > 0 || retyped.length > 0) {
    const detail = [
      missing.length ? `missing ${missing.join(', ')}` : '',
      retyped.length ? `type changed at ${retyped.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ')
    return { tool: toolName, status: 'breaking', detail }
  }
  if (added.length > 0) {
    return { tool: toolName, status: 'schema_widened', detail: `new optional ${added.join(', ')}`, added_fields: added }
  }
  return { tool: toolName, status: 'ok' }
}

function walk(
  expected: unknown,
  live: unknown,
  path: string,
  missing: string[],
  added: string[],
  retyped: string[],
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(live)) {
      retyped.push(path)
      return
    }
    // Element shape is what matters, not length; compare the first of each.
    if (expected.length > 0 && live.length > 0) walk(expected[0], live[0], `${path}[]`, missing, added, retyped)
    return
  }
  if (expected !== null && typeof expected === 'object') {
    if (live === null || typeof live !== 'object' || Array.isArray(live)) {
      retyped.push(path)
      return
    }
    const liveRecord = live as Record<string, unknown>
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in liveRecord)) {
        missing.push(`${path}.${key}`)
        continue
      }
      walk(value, liveRecord[key], `${path}.${key}`, missing, added, retyped)
    }
    for (const key of Object.keys(liveRecord)) {
      if (!(key in (expected as Record<string, unknown>))) added.push(`${path}.${key}`)
    }
    return
  }
  // A null transition is exactly the "silently wrong shape" FRD-7 exists to catch: a field that
  // becomes null, or stops being null, changes what a caller can do with it.
  if (expected === null || live === null) {
    if (expected !== live) retyped.push(path)
    return
  }
  if (typeof expected !== typeof live) retyped.push(path)
}

/**
 * AC-DRF-003.1 — adds newly-observed fields as OPTIONAL and changes nothing else. The field
 * paths are JSONPaths like `$.data.orders[].priority`, so the property must be inserted at that
 * depth; putting the leaf at the root would describe a response the target never sends.
 */
function widenSchema(tool: Tool, fields: string[]): void {
  const root = (tool.response.output_schema ?? {}) as Record<string, unknown>
  for (const field of fields) {
    // `$.data.orders[].priority` -> ['data', 'orders[]', 'priority']
    const segments = field.split('.').slice(1)
    const leaf = segments.pop()
    if (!leaf) continue

    let node = root
    for (const segment of segments) {
      const isArray = segment.endsWith('[]')
      const key = isArray ? segment.slice(0, -2) : segment
      node['type'] ??= 'object'
      const properties = (node['properties'] ??= {}) as Record<string, unknown>
      const child = (properties[key] ??= {}) as Record<string, unknown>
      if (isArray) {
        child['type'] = 'array'
        node = (child['items'] ??= {}) as Record<string, unknown>
      } else {
        node = child
      }
    }
    node['type'] ??= 'object'
    const properties = (node['properties'] ??= {}) as Record<string, unknown>
    // Optional by definition: it is never added to any `required` array.
    if (!(leaf in properties)) properties[leaf] = { type: 'string' }
  }
  root['type'] ??= 'object'
  tool.response.output_schema = root
}
