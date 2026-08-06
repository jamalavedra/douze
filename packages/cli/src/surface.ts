import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Cli, z } from 'incur'
import { paths, type RegistryState, type SurfaceTool } from '@douze/douzed'
import { explain } from './errors.js'
import { DouzeError } from '@douze/shared'
import type { RelayClient } from './relay-client.js'
import { RAW_OPTION, toZodObject } from './schema-to-zod.js'

/**
 * Command names the runtime owns. A recipe called `start` would otherwise silently replace
 * `douze start`, which is a worse outcome than refusing to mount it.
 */
export const RESERVED_GROUPS = new Set([
  'bundle',
  'completions',
  'doctor',
  'eject',
  'import',
  'mcp',
  'sessions',
  'skills',
  'start',
  'status',
  'stop',
])

type ErrorFn = (options: { code: string; message: string; retryable?: boolean }) => never

export interface SurfaceResult {
  changed: boolean
  /** AC-REC-001.4 — recipes that failed to load, reported by name rather than swallowed. */
  errors: { recipe: string; error: string }[]
  skipped: string[]
}

/**
 * #ToolSurfaceBuilder — turns a `RegistryState` into a live incur command tree.
 *
 * One tree serves both surfaces (ADR-007): incur exposes a leaf as `douze <recipe> <tool>` on
 * the CLI and joins the same path with `_` for MCP, so `<recipe>_<tool>` needs no separate
 * naming pass and two recipes defining `list` stay distinct with neither renamed (AC-RUN-001.3).
 *
 * `.command()` is a runtime call over a Map incur keeps live, and a mounted sub-Cli's Map is
 * held by reference, so rebuilding a recipe's tools after a hot reload is a mutation rather
 * than a restart (ADR-005).
 */
export class ToolSurfaceBuilder {
  private readonly groups = new Map<string, ReturnType<typeof Cli.create>>()
  private readonly rootCommands: Map<string, unknown>
  private revision = -1

  constructor(
    private readonly root: ReturnType<typeof Cli.create>,
    private readonly relay: RelayClient,
    private readonly fixturesDir: string = paths().fixtures,
  ) {
    this.rootCommands = liveCommands(root)
  }

  /** The live command map incur reads at MCP collect time and at CLI dispatch time. */
  get commands(): Map<string, unknown> {
    return this.rootCommands
  }

  /** AC-RUN-001.1 — one command per approved tool, JSON Schema converted to Zod at load time. */
  apply(state: RegistryState): SurfaceResult {
    if (state.revision === this.revision) {
      return { changed: false, errors: state.errors, skipped: [] }
    }
    this.revision = state.revision

    const byRecipe = new Map<string, SurfaceTool[]>()
    const skipped: string[] = []
    for (const tool of state.tools) {
      if (RESERVED_GROUPS.has(tool.recipe)) {
        if (!skipped.includes(tool.recipe)) skipped.push(tool.recipe)
        continue
      }
      const bucket = byRecipe.get(tool.recipe)
      if (bucket) bucket.push(tool)
      else byRecipe.set(tool.recipe, [tool])
    }

    for (const [recipe] of this.groups) {
      if (!byRecipe.has(recipe)) {
        this.groups.delete(recipe)
        this.rootCommands.delete(recipe)
      }
    }

    for (const [recipe, tools] of byRecipe) {
      const group = this.group(recipe)
      const commands = liveCommands(group)
      const wanted = new Set(tools.map((t) => t.tool.name))
      // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before mutating the collection being iterated
      for (const name of [...commands.keys()]) if (!wanted.has(name)) commands.delete(name)
      for (const tool of tools) group.command(tool.tool.name, this.define(tool) as never)
    }

    return { changed: true, errors: state.errors, skipped }
  }

  private group(recipe: string): ReturnType<typeof Cli.create> {
    const existing = this.groups.get(recipe)
    if (existing) return existing
    const group = Cli.create(recipe, { description: `Tools recorded from the ${recipe} target` })
    this.groups.set(recipe, group)
    // Mounting copies the sub-Cli's command Map by reference, so later edits land without remount.
    this.root.command(group as never)
    return group
  }

  private define(surface: SurfaceTool): Record<string, unknown> {
    const { tool } = surface
    const options = toZodObject(tool.request.input_schema).extend({ raw: RAW_OPTION })
    const readOnly = tool.side_effect === 'read'

    return {
      description: describe(surface),
      options,
      examples: examples(surface, this.fixturesDir),
      mcp: {
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: tool.side_effect === 'destructive',
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      },
      run: async (c: { options: Record<string, unknown>; error: ErrorFn }) => {
        try {
          return await this.relay.call(surface, c.options)
        } catch (error) {
          // AC-CON-004.* — the user may only ever see this string, so it carries the fix, and
          // `retryable: false` says in the protocol what the text says in prose.
          if (error instanceof DouzeError) {
            return c.error({ code: error.code, message: explain(error), retryable: false })
          }
          throw error
        }
      },
    }
  }
}

/**
 * Claude Desktop selects on the description alone (ADR-008), so the side effect and the
 * degradation reason belong in the text rather than only in annotations a client may ignore.
 */
function describe(surface: SurfaceTool): string {
  const parts = [surface.tool.description]
  if (surface.tool.side_effect === 'destructive') {
    parts.push('Destructive: requires confirm=true.')
  }
  // AC-RUN-001.5 — a degraded tool stays visible and says why it will refuse.
  if (surface.degraded) {
    parts.push(`Currently degraded and will refuse to run: ${surface.degraded_reason ?? 'contract drift'}.`)
  }
  return parts.join(' ')
}

/**
 * AC-CON-002.4 — `douze skills add` is incur's built-in generator; it renders whatever
 * `examples` a command carries. Drawing the values from the tool's own recorded fixture is what
 * makes the generated skill a worked example rather than a schema restatement.
 */
function examples(surface: SurfaceTool, fixturesDir: string): { options: Record<string, unknown>; description: string }[] {
  const fixture = surface.tool.fixtures[0]
  if (!fixture) return []
  let sample: unknown
  try {
    sample = JSON.parse(readFileSync(join(fixturesDir, fixture), 'utf8'))
  } catch {
    return []
  }

  const schema = surface.tool.request.input_schema as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>
    required?: string[]
  }
  const options: Record<string, unknown> = {}
  for (const name of schema.required ?? []) {
    options[name] = sampleValue(name, schema.properties?.[name], sample)
  }
  return [{ options, description: `Recorded against ${surface.base_url} (fixture ${fixture})` }]
}

function sampleValue(name: string, property: { type?: string; enum?: unknown[] } | undefined, sample: unknown): unknown {
  const found = findValue(sample, name)
  if (found !== undefined) return found
  if (property?.enum?.length) return property.enum[0]
  if (name === 'confirm') return true
  switch (property?.type) {
    case 'number':
    case 'integer':
      return 1
    case 'boolean':
      return true
    case 'array':
      return []
    default:
      return `<${name}>`
  }
}

/** Shallow-ish search for a key in the fixture, so `{data:{id:7}}` still yields an `id` example. */
function findValue(value: unknown, key: string, depth = 3): unknown {
  if (depth < 0 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) return findValue(value[0], key, depth - 1)
  const record = value as Record<string, unknown>
  if (key in record && isScalar(record[key])) return record[key]
  for (const nested of Object.values(record)) {
    const found = findValue(nested, key, depth - 1)
    if (found !== undefined) return found
  }
  return undefined
}

const isScalar = (value: unknown): boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/** incur keeps a Cli's command tree in a live Map; mutating it is how a hot reload lands. */
export function liveCommands(cli: ReturnType<typeof Cli.create>): Map<string, unknown> {
  const commands = Cli.toCommands.get(cli as never)
  if (!commands) throw new Error('incur did not expose a command map for this Cli')
  return commands as unknown as Map<string, unknown>
}

export { z }
