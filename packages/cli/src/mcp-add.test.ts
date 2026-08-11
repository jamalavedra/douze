import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENTS, addToAgent, configTarget, isAgent, parseMcpAdd, resolveServerName, snippet } from './commands/mcp-add.js'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'douze-mcpadd-'))

/** Registration writes down the entry point it was run from; tests pin one instead of argv[1]. */
const ENTRY = '/opt/douze-server/index.js'
beforeEach(() => {
  process.env['DOUZE_ENTRY'] = ENTRY
})
afterEach(() => {
  delete process.env['DOUZE_ENTRY']
})

describe('reserved server names (AC-CON-002.3)', () => {
  it('suffixes every name Claude Code reserves rather than failing', () => {
    for (const reserved of ['workspace', 'claude-in-chrome', 'computer-use', 'Claude Preview', 'Claude Browser']) {
      const resolved = resolveServerName(reserved)
      expect(resolved).not.toBe(reserved)
      expect(resolved).toBe(`${reserved}-douze`)
    }
  })

  it('matches reserved names case-insensitively', () => {
    expect(resolveServerName('Workspace')).toBe('Workspace-douze')
    expect(resolveServerName('COMPUTER-USE')).toBe('COMPUTER-USE-douze')
  })

  /** The list is Claude Code's. Cursor has no `workspace` server to collide with. */
  it('leaves the name alone for a client that reserves nothing', () => {
    expect(resolveServerName('workspace', 'cursor')).toBe('workspace')
    expect(resolveServerName('workspace', 'claude-desktop')).toBe('workspace-douze')
    const result = addToAgent({ agent: 'cursor', scope: 'project', name: 'workspace', cwd: scratch() })
    expect(result.name).toBe('workspace')
    expect(result).not.toHaveProperty('requested')
  })

  it('leaves an unreserved name alone', () => {
    expect(resolveServerName('douze')).toBe('douze')
    expect(resolveServerName('workspace-tools')).toBe('workspace-tools')
  })
})

describe('registration (AC-CON-002.1)', () => {
  it('launches this Node against this entry point, both absolute', () => {
    const cwd = scratch()
    const result = addToAgent({ agent: 'claude-code', scope: 'project', cwd })

    // Not `node` and not `douze`: a GUI client spawns with no shell PATH, and there is no `douze`
    // binary on a machine that unzipped the server.
    expect(result).toMatchObject({ command: process.execPath, args: [ENTRY, '--mcp'] })
    expect(result.path).toBe(join(cwd, '.mcp.json'))

    const written = JSON.parse(readFileSync(result.path, 'utf8'))
    expect(written.mcpServers.douze).toEqual({ type: 'stdio', command: process.execPath, args: [ENTRY, '--mcp'] })
  })

  it('registers a reserved name under its suffix and succeeds (COV_CON_002.2)', () => {
    const cwd = scratch()
    const result = addToAgent({ name: 'workspace', scope: 'project', cwd })

    expect(result.requested).toBe('workspace')
    expect(result.name).toBe('workspace-douze')
    const written = JSON.parse(readFileSync(result.path, 'utf8'))
    expect(written.mcpServers['workspace-douze']).toBeDefined()
    expect(written.mcpServers['workspace']).toBeUndefined()
  })

  it('keeps other servers in the file it edits', () => {
    const cwd = scratch()
    const path = join(cwd, '.mcp.json')
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'other' } }, unrelated: 1 }))

    addToAgent({ scope: 'project', cwd })
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.mcpServers.other).toEqual({ command: 'other' })
    expect(written.unrelated).toBe(1)
  })

  it('refuses to overwrite a config it cannot parse', () => {
    const cwd = scratch()
    writeFileSync(join(cwd, '.mcp.json'), '{ not json')
    expect(() => addToAgent({ scope: 'project', cwd })).toThrow(/not valid JSON/)
  })

  it('honours an explicit command instead of the entry point', () => {
    const cwd = scratch()
    expect(addToAgent({ scope: 'project', cwd, command: 'douze' })).toMatchObject({
      command: 'douze',
      args: ['--mcp'],
    })
  })
})

describe('client config targets (REQ-CON-002)', () => {
  it('maps each Claude Code scope to the file it reads it from', () => {
    expect(configTarget('claude-code', 'project', '/w').container).toEqual(['mcpServers'])
    expect(configTarget('claude-code', 'user', '/w').container).toEqual(['mcpServers'])
    expect(configTarget('claude-code', 'user', '/w').path).toMatch(/\.claude\.json$/)
    expect(configTarget('claude-code', 'local', '/w').container).toEqual(['projects', '/w', 'mcpServers'])
  })

  it("writes VS Code's `servers` key, not `mcpServers`", () => {
    const cwd = scratch()
    const result = addToAgent({ agent: 'vscode', scope: 'project', cwd })
    expect(result.path).toBe(join(cwd, '.vscode', 'mcp.json'))

    const written = JSON.parse(readFileSync(result.path, 'utf8'))
    expect(written.servers.douze).toMatchObject({ type: 'stdio' })
    expect(written.mcpServers).toBeUndefined()
  })

  it('puts a Cursor project registration in .cursor/mcp.json', () => {
    const cwd = scratch()
    const result = addToAgent({ agent: 'cursor', scope: 'project', cwd })
    expect(result.path).toBe(join(cwd, '.cursor', 'mcp.json'))
    expect(JSON.parse(readFileSync(result.path, 'utf8')).mcpServers.douze).toBeDefined()
  })

  it('names each remaining client a per-user file it can write', () => {
    for (const agent of AGENTS) {
      expect(configTarget(agent, 'user', '/w').path).toMatch(/\.json$/)
    }
    expect(configTarget('claude-desktop', 'user', '/w').path).toMatch(/claude_desktop_config\.json$/)
    expect(configTarget('windsurf', 'user', '/w').path).toMatch(/windsurf\/mcp_config\.json$/)
    expect(configTarget('vscode', 'user', '/w').path).toMatch(/Code\/User\/mcp\.json$/)
  })

  it('refuses a scope a client does not have rather than writing a nearby file', () => {
    expect(() => configTarget('windsurf', 'project', '/w')).toThrow(/no project scope/)
    expect(() => configTarget('claude-desktop', 'project', '/w')).toThrow(/no project scope/)
  })
})

describe('an unknown scope (AC-CON-002.1)', () => {
  it('names the scopes it has instead of writing the user file', () => {
    expect(() => configTarget('claude-code', 'global' as never, '/w')).toThrow(/user, project, local/)
    expect(() => addToAgent({ agent: 'claude-code', scope: 'global' as never, cwd: scratch() })).toThrow(
      /unknown scope "global"/,
    )
  })
})

/**
 * `"mcpServers": [...]` is wrong, but it is the user's file and those are the user's servers.
 * Replacing the container dropped every one of them without a word.
 */
describe('a container that is not an object', () => {
  it('refuses to register rather than dropping what is there', () => {
    const cwd = scratch()
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: [{ name: 'other' }] }))
    expect(() => addToAgent({ agent: 'claude-code', scope: 'project', cwd })).toThrow(/non-object "mcpServers"/)
    expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')).mcpServers).toEqual([{ name: 'other' }])
  })

  it('still creates the container when the file has none', () => {
    const cwd = scratch()
    const result = addToAgent({ agent: 'claude-code', scope: 'project', cwd })
    expect(JSON.parse(readFileSync(result.path, 'utf8')).mcpServers.douze.command).toBe(process.execPath)
  })
})

describe('unknown clients', () => {
  it('rejects an agent it does not write config for', () => {
    expect(isAgent('cursor')).toBe(true)
    expect(isAgent('zed')).toBe(false)
  })

  it('offers a paste-ready block with the paths already filled in', () => {
    const parsed = JSON.parse(snippet())
    expect(parsed.mcpServers.douze).toEqual({ type: 'stdio', command: process.execPath, args: [ENTRY, '--mcp'] })
  })
})

describe('argv parsing', () => {
  it('reads agent, name, scope, and command overrides', () => {
    expect(parseMcpAdd(['--agent', 'claude-code', '--scope', 'project', '--name', 'workspace'])).toEqual({
      agent: 'claude-code',
      scope: 'project',
      name: 'workspace',
    })
    expect(parseMcpAdd(['-c', 'pnpm douze --mcp'])).toEqual({ command: 'pnpm douze --mcp' })
    expect(parseMcpAdd([])).toEqual({})
  })
})
