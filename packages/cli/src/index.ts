import { Cli } from 'incur'
import { DaemonClient } from './daemon-client.js'
import { serveMcp } from './mcp.js'
import { RelayClient } from './relay-client.js'
import { ToolSurfaceBuilder } from './surface.js'
import { register as registerDaemon } from './commands/daemon.js'
import { register as registerBundle } from './commands/bundle.js'
import { addToClaudeCode, parseMcpAdd } from './commands/mcp-add.js'
import { register as registerMaintenance } from './commands/maintenance.js'

const VERSION = '0.1.0'

/**
 * Commands that answer without the recipe surface. `status` in particular must be able to
 * report a stopped daemon rather than starting one to ask it how it is.
 */
const SURFACE_FREE = new Set(['start', 'stop', 'status', 'sessions', 'import', 'bundle', 'doctor', 'eject'])

export function createCli(): ReturnType<typeof Cli.create> {
  const cli = Cli.create('douze', {
    description: 'Call your own authenticated dashboards as tools, executed in your signed-in browser.',
    version: VERSION,
    // ADR-007 — one surface, so the MCP name is the CLI path joined with `_`.
    mcp: { name: 'douze', title: 'Douze' },
  })
  registerDaemon(cli as never)
  registerBundle(cli as never)
  // doctor and eject share the daemon client the surface uses.
  registerMaintenance(cli as never, new DaemonClient())
  return cli
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // incur's own `--mcp` calls Mcp.serve, which snapshots the tool list at connect time. ADR-005
  // needs the opposite, so the flag is intercepted and served by the dynamic wrapper in mcp.ts.
  if (argv.includes('--mcp')) return runMcp()

  // AC-CON-002.1/.3 — Claude Code registration needs to report the scope it wrote and to handle
  // reserved names; incur's built-in does neither. Other agents still fall through to it.
  const mcpAdd = isClaudeCodeMcpAdd(argv)
  if (mcpAdd) {
    const result = addToClaudeCode(mcpAdd)
    process.stdout.write(
      `${result.requested ? `"${result.requested}" is reserved by Claude Code; registered as "${result.name}".\n` : ''}` +
        `Registered "${result.name}" at ${result.scope} scope in ${result.path}\n` +
        `  ${result.command} ${result.args.join(' ')}\n` +
        `Verify with: claude mcp list\n`,
    )
    return
  }

  const cli = createCli()
  if (needsSurface(argv)) await attachSurface(cli, argv)
  await cli.serve(argv)
}

/**
 * The MCP process: no argv parsing, no output on stdout except the protocol itself. It is built
 * from the same `createCli()` as the shell, so `mcp doctor` and `tools/list` cannot disagree —
 * the daemon-lifecycle commands opt out with `mcp: false`, leaving `status` and `sessions` as
 * the only non-recipe tools, which is what lets an agent diagnose REQ-CON-004 from inside a chat.
 */
async function runMcp(): Promise<void> {
  const daemon = new DaemonClient()
  const cli = createCli()
  const builder = new ToolSurfaceBuilder(cli, new RelayClient(daemon))
  await serveMcp({ builder, daemon, version: VERSION })
  await new Promise(() => undefined)
}

/**
 * AC-RUN-001.1 — the CLI's commands are built from the registry at load, the same registry the
 * MCP server reads, so the two surfaces cannot disagree about which tools exist.
 */
async function attachSurface(cli: ReturnType<typeof Cli.create>, argv: string[]): Promise<void> {
  const passive = isPassive(argv)
  const daemon = new DaemonClient(passive ? { autoStart: false } : {})
  const builder = new ToolSurfaceBuilder(cli, new RelayClient(daemon))
  try {
    const result = builder.apply(await daemon.registry())
    for (const skipped of result.skipped) {
      process.stderr.write(`douze: recipe "${skipped}" shadows a built-in command and was not mounted.\n`)
    }
    for (const failure of result.errors) {
      process.stderr.write(`douze: recipe "${failure.recipe}" failed to load — ${failure.error}\n`)
    }
  } catch (error) {
    // Help and version must render with the daemon down; a real call will fail loudly instead.
    if (!passive) throw error
  }
}

const isPassive = (argv: string[]): boolean =>
  argv.length === 0 || ['--help', '-h', '--version', '-v', '--llms', '--llms-full'].includes(argv[0] ?? '')

const needsSurface = (argv: string[]): boolean => !SURFACE_FREE.has(argv[0] ?? '')

function isClaudeCodeMcpAdd(argv: string[]): ReturnType<typeof parseMcpAdd> | null {
  const start = argv[0] === 'douze' ? 1 : 0
  if (argv[start] !== 'mcp' || argv[start + 1] !== 'add') return null
  const parsed = parseMcpAdd(argv.slice(start + 2))
  if (parsed.agent !== undefined && parsed.agent !== 'claude-code') return null
  return parsed
}

