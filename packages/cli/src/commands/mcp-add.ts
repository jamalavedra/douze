import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * REQ-CON-002 — one command registers Douze with Claude Code.
 *
 * incur ships an `mcp add`, but it shells out to `npx add-mcp` and reports agent names scraped
 * from that tool's stdout. AC-CON-002.1 asks for the *scope* that was written and AC-CON-002.3
 * asks for reserved-name handling, neither of which survives that indirection, so the Claude
 * Code path is written directly here. Every other agent still falls through to incur's built-in.
 */

/** AC-CON-002.3 — names Claude Code has taken for itself. Comparison is case-insensitive. */
export const RESERVED_SERVER_NAMES = [
  'workspace',
  'claude-in-chrome',
  'computer-use',
  'Claude Preview',
  'Claude Browser',
]

export type Scope = 'user' | 'project' | 'local'

export interface McpAddResult {
  name: string
  /** The requested name, present only when it had to be changed. */
  requested?: string
  scope: Scope
  /** AC-CON-002.1 — the file that changed, so the reported scope can be checked against it. */
  path: string
  command: string
  args: string[]
}

/**
 * AC-CON-002.3 — reserved means rejected-and-suffixed, not rejected-and-failed: the user asked
 * for a registration, and refusing one over a name would be a worse answer than renaming it.
 */
export function resolveServerName(requested: string): string {
  const taken = new Set(RESERVED_SERVER_NAMES.map((n) => n.toLowerCase()))
  if (!taken.has(requested.toLowerCase())) return requested
  let candidate = `${requested}-douze`
  let suffix = 2
  while (taken.has(candidate.toLowerCase())) candidate = `${requested}-douze-${suffix++}`
  return candidate
}

/**
 * Claude Code keeps user- and local-scope servers in `~/.claude.json` and project-scope servers
 * in a checked-in `.mcp.json`. The three are separate files-or-keys, so the scope the user asked
 * for and the file that changed are the same fact reported two ways.
 */
export function configTarget(scope: Scope, cwd: string): { path: string; container: string[] } {
  switch (scope) {
    case 'project':
      return { path: join(cwd, '.mcp.json'), container: ['mcpServers'] }
    case 'local':
      return { path: join(homedir(), '.claude.json'), container: ['projects', cwd, 'mcpServers'] }
    case 'user':
      return { path: join(homedir(), '.claude.json'), container: ['mcpServers'] }
  }
}

export function addToClaudeCode(
  options: { name?: string; scope?: Scope; command?: string; cwd?: string } = {},
): McpAddResult {
  const requested = options.name ?? 'douze'
  const name = resolveServerName(requested)
  const scope = options.scope ?? 'user'
  const cwd = options.cwd ?? process.cwd()
  const target = configTarget(scope, cwd)

  const config = readJson(target.path)
  const node = ensurePath(config, target.container)

  node[name] = {
    type: 'stdio',
    command: options.command ?? 'douze',
    args: ['--mcp'],
  }

  mkdirSync(dirname(target.path), { recursive: true })
  writeFileSync(target.path, `${JSON.stringify(config, null, 2)}\n`)

  return {
    name,
    ...(name === requested ? {} : { requested }),
    scope,
    path: target.path,
    command: options.command ?? 'douze',
    args: ['--mcp'],
  }
}

function ensurePath(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  let node = root
  for (const key of keys) {
    const existing = node[key]
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  return node
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    // A hand-broken config is the user's, not ours to silently replace.
    throw new Error(`${path} is not valid JSON; fix it before registering an MCP server.`)
  }
}

/** Parses the `mcp add` argv incur would otherwise have handled. */
export function parseMcpAdd(argv: string[]): { agent?: string; name?: string; scope?: Scope; command?: string } {
  const parsed: { agent?: string; name?: string; scope?: Scope; command?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!value || value.startsWith('-')) continue
    if (flag === '--agent') parsed.agent = value
    else if (flag === '--name') parsed.name = value
    else if (flag === '--scope') parsed.scope = value as Scope
    else if (flag === '--command' || flag === '-c') parsed.command = value
  }
  return parsed
}
