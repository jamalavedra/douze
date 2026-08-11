import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * REQ-CON-002 — one command registers Douze with an MCP client. Any MCP client: the daemon, the
 * extension and the recipes know nothing about who is calling, so the only Claude-specific thing
 * left was where the registration is written.
 *
 * incur ships an `mcp add`, but it shells out to `npx add-mcp`, which writes `command: "douze"` —
 * a binary a consumer never installs, since Douze ships as a zip and not on npm. It also reports
 * agent names scraped from that tool's stdout, so neither AC-CON-002.1 (report the scope written)
 * nor AC-CON-002.3 (reserved names) survives the indirection. Registration is written here.
 */

/** AC-CON-002.3 — names Claude Code has taken for itself. Comparison is case-insensitive. */
export const RESERVED_SERVER_NAMES = [
  'workspace',
  'claude-in-chrome',
  'computer-use',
  'Claude Preview',
  'Claude Browser',
]

export const SCOPES = ['user', 'project', 'local'] as const
export type Scope = (typeof SCOPES)[number]

export const isScope = (value: string): value is Scope => (SCOPES as readonly string[]).includes(value)

export const AGENTS = ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'windsurf'] as const
export type Agent = (typeof AGENTS)[number]

export const isAgent = (value: string): value is Agent => (AGENTS as readonly string[]).includes(value)

export interface McpAddResult {
  agent: Agent
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
 *
 * The list is Claude Code's, so it only applies to Claude Code. Cursor has no `workspace` server,
 * and renaming one there was a rule invented on the user's behalf for no reason.
 */
export function resolveServerName(requested: string, agent: Agent = 'claude-code'): string {
  if (!agent.startsWith('claude-')) return requested
  const taken = new Set(RESERVED_SERVER_NAMES.map((n) => n.toLowerCase()))
  if (!taken.has(requested.toLowerCase())) return requested
  let candidate = `${requested}-douze`
  let suffix = 2
  while (taken.has(candidate.toLowerCase())) candidate = `${requested}-douze-${suffix++}`
  return candidate
}

/** Where an app of this name keeps its per-user configuration on this platform. */
const appConfigDir = (app: string): string => {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', app)
  if (process.platform === 'win32') return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), app)
  return join(homedir(), '.config', app)
}

interface Target {
  path: string
  /** The key path the server entry is written under. VS Code's is `servers`; everyone else's is `mcpServers`. */
  container: string[]
}

/**
 * Where each client reads stdio servers from. A scope an agent does not have returns null rather
 * than a nearby file: writing a global registration for someone who asked for a project one is a
 * worse answer than saying the scope does not exist.
 */
const TARGETS: Record<Agent, (scope: Scope, cwd: string) => Target | null> = {
  // User and local scope share ~/.claude.json and differ by key path; project scope is a
  // checked-in .mcp.json.
  'claude-code': (scope, cwd) => {
    if (scope === 'project') return { path: join(cwd, '.mcp.json'), container: ['mcpServers'] }
    if (scope === 'local') return { path: join(homedir(), '.claude.json'), container: ['projects', cwd, 'mcpServers'] }
    return { path: join(homedir(), '.claude.json'), container: ['mcpServers'] }
  },
  // One config for the whole app. The .mcpb is still the friendlier install here; this exists so
  // a Desktop user who already unzipped the server does not have to build a bundle to use it.
  'claude-desktop': (scope) =>
    scope === 'user'
      ? { path: join(appConfigDir('Claude'), 'claude_desktop_config.json'), container: ['mcpServers'] }
      : null,
  cursor: (scope, cwd) => {
    if (scope === 'project') return { path: join(cwd, '.cursor', 'mcp.json'), container: ['mcpServers'] }
    return scope === 'user' ? { path: join(homedir(), '.cursor', 'mcp.json'), container: ['mcpServers'] } : null
  },
  vscode: (scope, cwd) => {
    if (scope === 'project') return { path: join(cwd, '.vscode', 'mcp.json'), container: ['servers'] }
    return scope === 'user' ? { path: join(appConfigDir('Code'), 'User', 'mcp.json'), container: ['servers'] } : null
  },
  windsurf: (scope) =>
    scope === 'user'
      ? { path: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'), container: ['mcpServers'] }
      : null,
}

export function configTarget(agent: Agent, scope: Scope, cwd: string): Target {
  // `--scope` arrives as an unchecked string. Unvalidated, an unknown one fell through to the user
  // file and the command then reported the scope the user typed — so `--scope global` said
  // "registered at global scope" while writing ~/.claude.json.
  if (!isScope(scope)) throw new Error(`unknown scope "${String(scope)}"; use one of ${SCOPES.join(', ')}.`)
  const target = TARGETS[agent](scope, cwd)
  if (!target) throw new Error(`${agent} has no ${scope} scope; use --scope user.`)
  return target
}

/**
 * How a client should launch us: this Node, running this entry point, both absolute.
 *
 * Not `node`: GUI clients spawn servers with a login shell's PATH nowhere in sight, so a bare
 * `node` may not resolve. Not `douze` either — there is no such binary on a consumer's machine.
 * `argv[1]` is the file the user just ran, which is the unzipped `index.js` we want written down.
 */
export function launcher(command?: string): { command: string; args: string[] } {
  if (command) return { command, args: ['--mcp'] }
  const entry = process.env['DOUZE_ENTRY'] ?? process.argv[1]
  if (!entry) throw new Error('cannot locate the douze entry point to register')
  return { command: process.execPath, args: [resolve(entry), '--mcp'] }
}

export function addToAgent(
  options: { agent?: Agent; name?: string; scope?: Scope; command?: string; cwd?: string } = {},
): McpAddResult {
  const agent = options.agent ?? 'claude-code'
  const requested = options.name ?? 'douze'
  const name = resolveServerName(requested, agent)
  const scope = options.scope ?? 'user'
  const cwd = options.cwd ?? process.cwd()
  const target = configTarget(agent, scope, cwd)
  const { command, args } = launcher(options.command)

  const config = readJson(target.path)
  const node = ensurePath(config, target.container, target.path)
  node[name] = { type: 'stdio', command, args }

  mkdirSync(dirname(target.path), { recursive: true })
  writeFileSync(target.path, `${JSON.stringify(config, null, 2)}\n`)

  return { agent, name, ...(name === requested ? {} : { requested }), scope, path: target.path, command, args }
}

/** What to hand someone whose client we do not write config for: the block, ready to paste. */
export function snippet(name = 'douze', command?: string): string {
  const launch = launcher(command)
  return JSON.stringify({ mcpServers: { [name]: { type: 'stdio', ...launch } } }, null, 2)
}

/**
 * Creates the container the server entry goes in, and refuses to replace one that is there but is
 * not an object. `"mcpServers": [...]` is wrong, but it is the user's — dropping it took every
 * server they had registered with it and said nothing.
 */
function ensurePath(root: Record<string, unknown>, keys: string[], path: string): Record<string, unknown> {
  let node = root
  const walked: string[] = []
  for (const key of keys) {
    walked.push(key)
    const existing = node[key]
    if (existing === undefined || existing === null) node[key] = {}
    else if (typeof existing !== 'object' || Array.isArray(existing)) {
      throw new Error(
        `${path} has a non-object "${walked.join('.')}"; fix it before registering an MCP server.`,
      )
    }
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
export function parseMcpAdd(argv: string[]): { agent?: string; name?: string; scope?: string; command?: string } {
  const parsed: { agent?: string; name?: string; scope?: string; command?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!value || value.startsWith('-')) continue
    if (flag === '--agent') parsed.agent = value
    else if (flag === '--name') parsed.name = value
    else if (flag === '--scope') parsed.scope = value
    else if (flag === '--command' || flag === '-c') parsed.command = value
  }
  return parsed
}
