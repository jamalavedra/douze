import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addToClaudeCode, configTarget, parseMcpAdd, resolveServerName } from './commands/mcp-add.js'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'douze-mcpadd-'))

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

  it('leaves an unreserved name alone', () => {
    expect(resolveServerName('douze')).toBe('douze')
    expect(resolveServerName('workspace-tools')).toBe('workspace-tools')
  })
})

describe('registration (AC-CON-002.1)', () => {
  it('writes a stdio entry invoking `douze --mcp` and reports the file it changed', () => {
    const cwd = scratch()
    const result = addToClaudeCode({ scope: 'project', cwd })

    expect(result).toMatchObject({ name: 'douze', scope: 'project', command: 'douze', args: ['--mcp'] })
    expect(result.path).toBe(join(cwd, '.mcp.json'))

    const written = JSON.parse(readFileSync(result.path, 'utf8'))
    expect(written.mcpServers.douze).toEqual({ type: 'stdio', command: 'douze', args: ['--mcp'] })
  })

  it('registers a reserved name under its suffix and succeeds (COV_CON_002.2)', () => {
    const cwd = scratch()
    const result = addToClaudeCode({ name: 'workspace', scope: 'project', cwd })

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

    addToClaudeCode({ scope: 'project', cwd })
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.mcpServers.other).toEqual({ command: 'other' })
    expect(written.unrelated).toBe(1)
  })

  it('refuses to overwrite a config it cannot parse', () => {
    const cwd = scratch()
    writeFileSync(join(cwd, '.mcp.json'), '{ not json')
    expect(() => addToClaudeCode({ scope: 'project', cwd })).toThrow(/not valid JSON/)
  })

  it('maps each scope to the file Claude Code reads it from', () => {
    expect(configTarget('project', '/w').container).toEqual(['mcpServers'])
    expect(configTarget('user', '/w').container).toEqual(['mcpServers'])
    expect(configTarget('user', '/w').path).toMatch(/\.claude\.json$/)
    expect(configTarget('local', '/w').container).toEqual(['projects', '/w', 'mcpServers'])
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
