import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Cli, Mcp } from 'incur'
import type { RegistryState, SurfaceTool } from '@douze/douzed'
import type { Tool } from '@douze/shared'
import type { RelayClient } from './relay-client.js'
import { RESERVED_GROUPS, ToolSurfaceBuilder } from './surface.js'
import { toZodObject } from './schema-to-zod.js'

const tool = (name: string, overrides: Partial<Tool> = {}): Tool => ({
  name,
  description: `List things from ${name}`,
  side_effect: 'read',
  confidence: 0.9,
  observations: 4,
  approved: true,
  request: {
    method: 'GET',
    path: `/${name}`,
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', description: 'Filter by status' }, limit: { type: 'number' } },
      required: ['status'],
    },
    headers: {},
  },
  response: { output_schema: {}, primary_payload_path: '$.data' },
  fixtures: [],
  flags: {
    sparse: false,
    derived_name: false,
    unverified: false,
    degraded: false,
    user_edited: [],
    suggestions: {},
  },
  ...overrides,
})

const surface = (recipe: string, t: Tool, overrides: Partial<SurfaceTool> = {}): SurfaceTool => ({
  qualified_name: `${recipe}_${t.name}`,
  recipe,
  base_url: `https://${recipe}.test`,
  tool: t,
  credential_source: [{ kind: 'cookie' }],
  degraded: false,
  ...overrides,
})

const state = (tools: SurfaceTool[], revision: number): RegistryState => ({ tools, errors: [], revision })

function build(): { builder: ToolSurfaceBuilder; relay: RelayClient; root: ReturnType<typeof Cli.create> } {
  const root = Cli.create('douze', { description: 'Douze', version: '0.1.0' })
  const relay = { call: vi.fn().mockResolvedValue({ status: 200, duration_ms: 1, data: {} }) } as unknown as RelayClient
  return { builder: new ToolSurfaceBuilder(root, relay, '/nonexistent-fixtures'), relay, root }
}

const mcpNames = (builder: ToolSurfaceBuilder): string[] =>
  Mcp.collectTools(builder.commands as Map<string, never>, []).map((t) => t.name)

describe('namespacing (AC-RUN-001.2 / AC-RUN-001.3)', () => {
  it('keeps two recipes that both define `list` distinct, renaming neither', () => {
    const { builder } = build()
    builder.apply(state([surface('jira', tool('list')), surface('linear', tool('list'))], 1))

    expect(mcpNames(builder)).toEqual(['jira_list', 'linear_list'])

    const groups = builder.commands
    expect([...groups.keys()].sort()).toEqual(['jira', 'linear'])
    for (const recipe of ['jira', 'linear']) {
      const group = groups.get(recipe) as { commands: Map<string, unknown> }
      // `douze <recipe> list` — the tool keeps its own name inside its own group.
      expect([...group.commands.keys()]).toEqual(['list'])
    }
  })

  it('exposes the same JSON Schema over MCP that the CLI validates with', () => {
    const { builder } = build()
    builder.apply(state([surface('jira', tool('list'))], 1))

    const [entry] = Mcp.collectTools(builder.commands as Map<string, never>, [])
    const zod = (entry!.command as { options: { shape: Record<string, unknown> } }).options.shape

    expect(entry!.inputSchema.properties).toHaveProperty('status')
    expect(entry!.inputSchema.properties).toHaveProperty('limit')
    // AC-RUN-004.1 — `raw` is added by the runtime, so it appears on both surfaces or neither.
    expect(entry!.inputSchema.properties).toHaveProperty('raw')
    expect(Object.keys(zod).sort()).toEqual(Object.keys(entry!.inputSchema.properties).sort())
    expect(entry!.inputSchema.required).toEqual(['status'])
  })
})

describe('JSON Schema to Zod (AC-RUN-001.1)', () => {
  it('carries required, descriptions, and types across', () => {
    const schema = toZodObject({
      type: 'object',
      properties: { id: { type: 'string', description: 'Order id' }, limit: { type: 'number' } },
      required: ['id'],
    })
    expect(schema.safeParse({ id: 'o-1' }).success).toBe(true)
    expect(schema.safeParse({ limit: 3 }).success).toBe(false)
    expect(schema.safeParse({ id: 'o-1', limit: 'three' }).success).toBe(false)
    expect(schema.shape['id']?.description).toBe('Order id')
  })

  it('survives an empty or absent schema rather than failing the whole surface', () => {
    expect(toZodObject({ type: 'object', properties: {} }).safeParse({}).success).toBe(true)
    expect(toZodObject(undefined).safeParse({}).success).toBe(true)
    expect(toZodObject({ type: 'string' }).safeParse({}).success).toBe(true)
  })
})

describe('hot reload (AC-RUN-002)', () => {
  it('adds, updates, and removes tools in place on a new revision', () => {
    const { builder } = build()
    builder.apply(state([surface('jira', tool('list'))], 1))
    expect(mcpNames(builder)).toEqual(['jira_list'])

    builder.apply(state([surface('jira', tool('list')), surface('jira', tool('get'))], 2))
    expect(mcpNames(builder)).toEqual(['jira_get', 'jira_list'])

    const edited = tool('list', { description: 'A better description' })
    builder.apply(state([surface('jira', edited)], 3))
    expect(mcpNames(builder)).toEqual(['jira_list'])
    expect(Mcp.collectTools(builder.commands as Map<string, never>, [])[0]?.description).toBe(
      'A better description',
    )

    builder.apply(state([], 4))
    expect(mcpNames(builder)).toEqual([])
    expect([...builder.commands.keys()]).toEqual([])
  })

  it('does nothing when the revision has not moved', () => {
    const { builder } = build()
    expect(builder.apply(state([surface('jira', tool('list'))], 7)).changed).toBe(true)
    expect(builder.apply(state([surface('jira', tool('list'))], 7)).changed).toBe(false)
  })
})

describe('degraded and destructive tools', () => {
  it('exposes a degraded tool and names the reason in the description (AC-RUN-001.5)', () => {
    const { builder } = build()
    builder.apply(
      state([surface('jira', tool('list'), { degraded: true, degraded_reason: 'fixture "list.json" is missing' })], 1),
    )
    const [entry] = Mcp.collectTools(builder.commands as Map<string, never>, [])
    expect(entry!.name).toBe('jira_list')
    expect(entry!.description).toContain('fixture "list.json" is missing')
  })

  it('marks read tools readOnly and destructive tools destructive', () => {
    const { builder } = build()
    builder.apply(
      state(
        [
          surface('jira', tool('list')),
          surface('jira', tool('delete_issue', { side_effect: 'destructive' })),
        ],
        1,
      ),
    )
    const tools = Mcp.collectTools(builder.commands as Map<string, never>, [])
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('jira_list')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('jira_delete_issue')?.annotations?.destructiveHint).toBe(true)
    expect(byName.get('jira_delete_issue')?.description).toContain('confirm=true')
  })
})

describe('reserved group names', () => {
  it('refuses to mount a recipe that would shadow a built-in command', () => {
    const { builder } = build()
    const result = builder.apply(state([surface('start', tool('list')), surface('jira', tool('list'))], 1))

    expect(result.skipped).toEqual(['start'])
    expect(mcpNames(builder)).toEqual(['jira_list'])
    expect(RESERVED_GROUPS.has('start')).toBe(true)
  })
})

describe('worked examples from fixtures (AC-CON-002.4)', () => {
  it('fills required parameters from the tool\'s own recorded fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'douze-fixtures-'))
    writeFileSync(join(dir, 'list.json'), JSON.stringify({ data: [{ id: 'o-1', status: 'open' }] }))

    const root = Cli.create('douze', { description: 'Douze', version: '0.1.0' })
    const relay = { call: vi.fn() } as unknown as RelayClient
    const builder = new ToolSurfaceBuilder(root, relay, dir)
    builder.apply(state([surface('jira', tool('list', { fixtures: ['list.json'] }))], 1))

    const group = builder.commands.get('jira') as { commands: Map<string, { examples: unknown[] }> }
    expect(group.commands.get('list')?.examples).toEqual([
      { options: { status: 'open' }, description: 'Recorded against https://jira.test (fixture list.json)' },
    ])
  })

  it('falls back to a placeholder when the fixture holds no matching value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'douze-fixtures-'))
    writeFileSync(join(dir, 'list.json'), JSON.stringify({ data: [{ id: 'o-1' }] }))

    const root = Cli.create('douze', { description: 'Douze', version: '0.1.0' })
    const builder = new ToolSurfaceBuilder(root, { call: vi.fn() } as unknown as RelayClient, dir)
    builder.apply(state([surface('jira', tool('list', { fixtures: ['list.json'] }))], 1))

    const group = builder.commands.get('jira') as { commands: Map<string, { examples: { options: unknown }[] }> }
    expect(group.commands.get('list')?.examples[0]?.options).toEqual({ status: '<status>' })
  })

  it('emits no example when the tool has no fixture on disk', () => {
    const { builder } = build()
    builder.apply(state([surface('jira', tool('list', { fixtures: ['gone.json'] }))], 1))
    const group = builder.commands.get('jira') as { commands: Map<string, { examples: unknown[] }> }
    expect(group.commands.get('list')?.examples).toEqual([])
  })
})

describe('tool execution wiring', () => {
  it('routes a CLI call through the relay client with the parsed options', async () => {
    const { builder, relay } = build()
    builder.apply(state([surface('jira', tool('list'))], 1))

    const group = builder.commands.get('jira') as { commands: Map<string, { run: (c: unknown) => unknown }> }
    const command = group.commands.get('list')!
    await command.run({ options: { status: 'open', raw: false }, error: () => undefined })

    expect(relay.call).toHaveBeenCalledWith(
      expect.objectContaining({ qualified_name: 'jira_list' }),
      { status: 'open', raw: false },
    )
  })
})
