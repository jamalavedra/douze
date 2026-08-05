import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'incur'
import { installToken, readRuntime } from '@recon/recond'
import { DEFAULT_PORT } from '@recon/shared'
import { zip, type ZipEntry } from '../zip.js'

type ErrorFn = (options: { code: string; message: string; exitCode?: number }) => never

const VERSION = '0.1.0'

/**
 * ADR-008 — `.mcpb` is the primary install path, because Claude Desktop's only alternative is
 * hand-edited JSON. AC-CON-001.4 is what makes this a one-time act: the bundle carries no tool
 * definitions at all, only the address of the relay, so a recipe approved next month appears
 * without a rebuild.
 */
export function register(cli: { command: (name: string, definition: unknown) => unknown }): void {
  cli.command('bundle', {
    description: 'Emit a .mcpb bundle installable by double-click in Claude Desktop',
    options: z.object({
      out: z.string().default('recon.mcpb').describe('Path to write the bundle to'),
      dist: z.string().optional().describe('Directory holding the built MCP server (defaults to this package\'s dist)'),
    }),
    mcp: false,
    run(c: { options: { out: string; dist?: string }; error: ErrorFn }) {
      const dist = resolve(c.options.dist ?? defaultDist())
      if (!existsSync(join(dist, 'index.js'))) {
        return c.error({
          code: 'NOT_BUILT',
          message: `No built MCP server at ${dist}/index.js. Run \`pnpm --filter @recon/cli build\` first.`,
          exitCode: 1,
        })
      }

      const entries: ZipEntry[] = [
        { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest(), null, 2), 'utf8') },
      ]
      for (const file of walk(dist)) {
        entries.push({ path: join('server', relative(dist, file)), data: readFileSync(file) })
      }

      const out = resolve(c.options.out)
      writeFileSync(out, zip(entries))
      return { bundle: out, files: entries.length, bytes: statSync(out).size }
    },
  })
}

/**
 * AC-CON-001.2 — `user_config` is what Claude Desktop renders as a settings form, so the relay
 * URL and the install token are declared here rather than baked in. AC-CON-001.3 — `type: node`
 * runs on the Node that ships inside Claude Desktop, so nothing extra is installed.
 */
function manifest(): Record<string, unknown> {
  const runtime = readRuntime()
  return {
    manifest_version: '0.2',
    name: 'recon',
    display_name: 'Recon',
    version: VERSION,
    description: 'Call your own authenticated dashboards as tools, executed in your signed-in browser.',
    author: { name: 'Recon' },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.js', '--mcp'],
        env: {
          RECON_RELAY_URL: '${user_config.relay_url}',
          RECON_INSTALL_TOKEN: '${user_config.install_token}',
        },
      },
    },
    user_config: {
      relay_url: {
        type: 'string',
        title: 'Recon relay URL',
        description: 'Where recond is listening. Run `recon status` to check.',
        default: `http://127.0.0.1:${runtime?.port ?? DEFAULT_PORT}`,
        required: true,
      },
      install_token: {
        type: 'string',
        title: 'Install token',
        description: 'The per-install token from ~/.recon/token. Recon cannot be driven without it.',
        default: safeToken(),
        sensitive: true,
        required: true,
      },
    },
    compatibility: { claude_desktop: '>=0.10.0', platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=22' } },
  }
}

const safeToken = (): string => {
  try {
    return installToken()
  } catch {
    return ''
  }
}

const defaultDist = (): string => join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist')

function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(path))
    else if (!entry.name.endsWith('.map')) found.push(path)
  }
  return found
}
