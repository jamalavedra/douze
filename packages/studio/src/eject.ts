import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Recipe, Tool } from '@recon/shared'
import type { Fixture } from './fixtures.js'
import type { JsonSchema } from './types.js'

/**
 * #PackageEjector — FRD-8. Compiles one recipe into a standalone incur package.
 *
 * Eject is the escape hatch, not the default path (ADR-005): the runtime interprets recipes so a
 * description edit reaches a running client in seconds, and only an artifact you want to ship,
 * run in CI, or hand to a machine with no Recon install is worth generating code for.
 *
 * Emission is a pure function of the recipe and its fixtures — no clock, no randomness, no
 * filesystem ordering — so two ejects of the same recipe are byte-identical (AC-EJT-001.4).
 */

/** Pinned so an eject is reproducible; bump with the workspace's incur. */
const INCUR_VERSION = '0.4.26'
const TSX_VERSION = '4.23.1'
const TYPESCRIPT_VERSION = '7.0.2'

export interface EjectInput {
  recipe: Recipe
  /** Root the recipe's `fixtures[]` references resolve against. */
  fixturesDir: string
  /** Directory to emit into; created if absent. */
  out: string
}

export interface EjectResult {
  dir: string
  /** Emitted paths, relative to `dir`, in emission order. */
  files: string[]
  /** Approved tool names that became commands. */
  tools: string[]
}

/** AC-EJT-001.1 — one command per approved tool. Unapproved candidates are not tools. */
export function eject(input: EjectInput): EjectResult {
  const { recipe } = input
  const approved = [...recipe.tools].filter((t) => t.approved).sort((a, b) => a.name.localeCompare(b.name))
  const tools = approved.map((tool) => describeTool(tool, recipe, input.fixturesDir))

  const files: Record<string, string> = {
    'package.json': packageJson(recipe),
    'tsconfig.json': tsconfig(recipe),
    'src/tools.ts': toolsModule(recipe, tools),
    'src/execute.ts': executeModule(recipe),
    'src/index.ts': indexModule(recipe),
    'src/replay.ts': replayModule(recipe),
  }

  const written: string[] = []
  for (const [name, contents] of Object.entries(files)) {
    const path = join(input.out, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    written.push(name)
  }
  return { dir: input.out, files: written, tools: tools.map((t) => t.name) }
}

// ---------------------------------------------------------------------------
// Tool model — everything the emitted package needs, resolved at eject time.
// ---------------------------------------------------------------------------

interface EjectedExample {
  args: Record<string, unknown>
  options: Record<string, unknown>
  description: string
}

interface EjectedTool {
  name: string
  description: string
  side_effect: Tool['side_effect']
  request: { method: string; path: string; headers: Record<string, string>; graphql?: { operation: string; document: string } }
  /** AC-EJT-001.1 — path parameters and required parameters. */
  args_schema: JsonSchema
  /** AC-EJT-001.1 — everything optional, plus the `raw` and `confirm` control flags. */
  options_schema: JsonSchema
  /** AC-EJT-001.2 — from the response contract. */
  output_schema: JsonSchema
  primary_payload_path?: string
  examples: EjectedExample[]
  /** AC-EJT-002.3 — the stored fixture the replay test checks against. */
  fixture?: Fixture
}

/** Control flags are never positional: `cancel_order 1044 true` is too easy to get wrong. */
const CONTROL_PARAMS = new Set(['raw', 'confirm'])

function describeTool(tool: Tool, recipe: Recipe, fixturesDir: string): EjectedTool {
  const schema = tool.request.input_schema as JsonSchema
  const properties = (schema['properties'] as Record<string, JsonSchema> | undefined) ?? {}
  const required = new Set((schema['required'] as string[] | undefined) ?? [])
  const pathParams = [...tool.request.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '')

  const argKeys = [...new Set([...pathParams, ...required])].filter((k) => !CONTROL_PARAMS.has(k)).sort()
  const optionKeys = Object.keys(properties)
    .filter((k) => !argKeys.includes(k))
    .sort()

  const fixture = loadFixture(tool, fixturesDir)
  return {
    name: tool.name,
    description: describe(tool),
    side_effect: tool.side_effect,
    request: {
      method: tool.request.method,
      path: tool.request.path,
      headers: tool.request.headers,
      ...(tool.request.graphql !== undefined ? { graphql: tool.request.graphql } : {}),
    },
    args_schema: pick(properties, argKeys, argKeys),
    // `confirm` stays required even as an option, so a destructive call still cannot omit it.
    options_schema: pick(properties, optionKeys, optionKeys.filter((k) => k === 'confirm')),
    output_schema: tool.response.output_schema,
    ...(tool.response.primary_payload_path !== undefined
      ? { primary_payload_path: tool.response.primary_payload_path }
      : {}),
    examples: examplesFor(tool, recipe, argKeys, optionKeys, properties, fixture),
    ...(fixture !== undefined ? { fixture } : {}),
  }
}

function describe(tool: Tool): string {
  const parts = [tool.description]
  if (tool.side_effect === 'destructive') parts.push('Destructive: requires confirm=true.')
  return parts.join(' ')
}

function pick(properties: Record<string, JsonSchema>, keys: string[], required: string[]): JsonSchema {
  const picked: Record<string, JsonSchema> = {}
  for (const key of keys) {
    const property = properties[key]
    if (property !== undefined) picked[key] = property
  }
  const schema: JsonSchema = { type: 'object', properties: picked }
  if (required.length > 0) schema['required'] = [...required].sort()
  return schema
}

function loadFixture(tool: Tool, fixturesDir: string): Fixture | undefined {
  const reference = tool.fixtures[0]
  if (reference === undefined) return undefined
  try {
    return JSON.parse(readFileSync(join(fixturesDir, reference), 'utf8')) as Fixture
  } catch {
    return undefined
  }
}

/**
 * AC-EJT-001.2 — at least one `examples` entry drawn from a fixture. Values come from the
 * recorded exchange, so the example is a call that actually happened rather than a restatement
 * of the schema.
 */
function examplesFor(
  tool: Tool,
  recipe: Recipe,
  argKeys: string[],
  optionKeys: string[],
  properties: Record<string, JsonSchema>,
  fixture: Fixture | undefined,
): EjectedExample[] {
  const source = fixture === undefined ? undefined : { url: fixture.request.url, body: fixture.request.body }
  const args: Record<string, unknown> = {}
  for (const key of argKeys) args[key] = sampleValue(key, properties[key], source)

  const options: Record<string, unknown> = {}
  if (tool.side_effect === 'destructive' && optionKeys.includes('confirm')) options['confirm'] = true

  const provenance = fixture === undefined ? 'the recorded session' : `fixture ${tool.fixtures[0] ?? ''}`
  return [{ args, options, description: `Recorded against ${recipe.target.base_url} (${provenance})` }]
}

function sampleValue(name: string, property: JsonSchema | undefined, source: { url: string; body: unknown } | undefined): unknown {
  if (source !== undefined) {
    const fromQuery = queryValue(source.url, name)
    if (fromQuery !== undefined) return fromQuery
    const fromBody = findValue(source.body, name)
    if (fromBody !== undefined) return fromBody
    const fromPath = pathValue(source.url, name)
    if (fromPath !== undefined) return fromPath
  }
  const examples = property?.['examples']
  if (Array.isArray(examples) && examples.length > 0) return examples[0]
  switch (property?.['type']) {
    case 'integer':
    case 'number':
      return 1
    case 'boolean':
      return true
    case 'array':
      return []
    default:
      return `<${name}>`
  }
}

function queryValue(url: string, name: string): string | undefined {
  try {
    return new URL(url).searchParams.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/** A path parameter's value is the last identifier-shaped segment of the recorded URL. */
function pathValue(url: string, name: string): string | undefined {
  if (!/id$/i.test(name)) return undefined
  try {
    const segments = new URL(url).pathname.split('/').filter((s) => s.length > 0)
    return [...segments].reverse().find((s) => /^\d+$/.test(s))
  } catch {
    return undefined
  }
}

function findValue(value: unknown, key: string, depth = 3): unknown {
  if (depth < 0 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) return findValue(value[0], key, depth - 1)
  const record = value as Record<string, unknown>
  const direct = record[key]
  if (key in record && isScalar(direct)) return direct
  for (const nested of Object.values(record)) {
    const found = findValue(nested, key, depth - 1)
    if (found !== undefined) return found
  }
  return undefined
}

const isScalar = (value: unknown): boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/** AC-EJT-001.5 — every file names its source recipe and that recipe's schema version. */
function header(recipe: Recipe): string {
  return [
    `// Generated by \`recon eject\` from recipe "${recipe.name}" (recipe schema version ${recipe.version}).`,
    '// Do not edit: re-eject to regenerate. Emission is deterministic and byte-identical.',
    '',
  ].join('\n')
}

/** AC-EJT-001.4 — sorted keys and fixed formatting; nothing here reads a clock. */
function stableJson(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key])
  return out
}

/** AC-EJT-001.3 — `incur` is the only runtime dependency; nothing here is a Recon module. */
function packageJson(recipe: Recipe): string {
  return `${stableJson({
    _recon: `Generated by \`recon eject\` from recipe "${recipe.name}" (recipe schema version ${recipe.version}). Do not edit; re-eject to regenerate.`,
    name: `${recipe.name}-tools`,
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: { start: 'tsx src/index.ts', test: 'tsx src/replay.ts' },
    dependencies: { incur: INCUR_VERSION },
    devDependencies: { tsx: TSX_VERSION, typescript: TYPESCRIPT_VERSION },
  })}\n`
}

function tsconfig(recipe: Recipe): string {
  return `${header(recipe)}${stableJson({
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
    },
    include: ['src'],
  })}\n`
}

function toolsModule(recipe: Recipe, tools: EjectedTool[]): string {
  return `${header(recipe)}${TOOLS_TYPES}
export const RECIPE: EjectedRecipe = ${stableJson({
    name: recipe.name,
    version: recipe.version,
    base_url: recipe.target.base_url,
    auth: recipe.auth,
  })}

export const TOOLS: EjectedTool[] = ${stableJson(tools)}
`
}

const TOOLS_TYPES = `export interface EjectedRecipe {
  name: string
  version: number
  base_url: string
  auth: { mode: string; keychain_ref?: string; refresh_endpoint?: string; credential_source?: unknown[] }
}

export interface EjectedFixture {
  tool: string
  recorded_at: string
  request: { method: string; url: string; headers: Record<string, string>; body?: unknown }
  response: { status: number; headers: Record<string, string>; body?: unknown }
}

export interface EjectedTool {
  name: string
  description: string
  side_effect: 'read' | 'write' | 'destructive'
  request: {
    method: string
    path: string
    headers: Record<string, string>
    graphql?: { operation: string; document: string }
  }
  args_schema: Record<string, unknown>
  options_schema: Record<string, unknown>
  output_schema: Record<string, unknown>
  primary_payload_path?: string
  examples: { args: Record<string, unknown>; options: Record<string, unknown>; description: string }[]
  fixture?: EjectedFixture
}
`

/**
 * The execution module. Relay-first when recond is reachable (AC-EJT-002.1), direct with the
 * degraded notice when it is not and Headless Mode is configured (AC-EJT-002.2). The relay path
 * posts to recond exactly as the interpreted client does, so guards — rate limit, destructive
 * confirmation, degradation — still run inside the daemon and cannot be bypassed by ejecting.
 */
function executeModule(recipe: Recipe): string {
  return `${header(recipe)}import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RECIPE, type EjectedTool } from './tools.js'

/** Copied verbatim from recond's headless executor: this path must announce itself. */
export const DEGRADED_NOTICE =
  'Executed via Headless Mode — the degraded path. Requests were issued directly from recond ' +
  'using a stored session rather than through your signed-in browser.'

/** Matches the interpreted runtime's result cap so an ejected call returns the same bytes. */
export const MAX_RESULT_BYTES = 32 * 1024

export interface Result {
  status: number
  duration_ms: number
  data: unknown
  note?: string
  notice?: string
  truncated?: { message: string; untrimmed_bytes: number; returned_bytes: number }
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface Relay {
  url: string
  token: string
}

/** recond writes its port and install token under RECON_HOME; env vars override for CI. */
function relayTarget(): Relay | null {
  const url = process.env['RECON_RELAY_URL']
  const token = process.env['RECON_TOKEN']
  if (url && token) return { url, token }
  const home = process.env['RECON_HOME'] ?? join(homedir(), '.recon')
  try {
    const runtime = JSON.parse(readFileSync(join(home, 'recond.json'), 'utf8')) as { port: number }
    return {
      url: 'http://127.0.0.1:' + String(runtime.port),
      token: readFileSync(join(home, 'token'), 'utf8').trim(),
    }
  } catch {
    return null
  }
}

export async function execute(tool: EjectedTool, params: Record<string, unknown>): Promise<Result> {
  const started = Date.now()
  const relay = relayTarget()
  if (relay) {
    const response = await viaRelay(relay, tool, params)
    // A null means the daemon was not answering. Any other failure is a real error and must not
    // silently fall through to the degraded path (AC-CON-004.4).
    if (response !== null) {
      return shape(tool, params, response.status ?? 0, response.body, response.duration_ms ?? Date.now() - started)
    }
  }
  const direct = await viaHeadless(tool, params)
  return { ...shape(tool, params, direct.status, direct.body, Date.now() - started), notice: DEGRADED_NOTICE }
}

interface RelayResponse {
  status?: number
  body?: unknown
  duration_ms?: number
}

async function viaRelay(relay: Relay, tool: EjectedTool, params: Record<string, unknown>): Promise<RelayResponse | null> {
  const path = '/relay/' + encodeURIComponent(RECIPE.name) + '/' + encodeURIComponent(tool.name)
  let response: Response
  try {
    response = await fetch(relay.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-recon-token': relay.token },
      body: JSON.stringify({ args: params, timeout_ms: 300000 }),
    })
  } catch {
    return null
  }
  const body = (await response.json().catch(() => undefined)) as RelayResponse & { error?: string; code?: string }
  if (!response.ok) {
    throw new ToolError(body?.code ?? 'relay_failed', body?.error ?? 'relay returned ' + String(response.status))
  }
  return body
}

/**
 * AC-EJT-002.2 — the degraded path. Mirrors recond's headless executor: the stored session is
 * attached as a cookie, and a 401 triggers the recipe's refresh endpoint exactly once.
 */
async function viaHeadless(tool: EjectedTool, params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (RECIPE.auth.mode !== 'headless' || !RECIPE.auth.keychain_ref) {
    throw new ToolError(
      'relay_unreachable',
      'recond is not reachable and Headless Mode is not enabled for "' +
        RECIPE.name +
        '". Start recond so the browser relay can run, or enable Headless Mode.',
    )
  }
  const session = storedSession(RECIPE.auth.keychain_ref)
  if (!session) {
    throw new ToolError(
      'session_expired',
      'No stored session for "' + RECIPE.name + '". Browser relay is required to re-establish it.',
    )
  }

  let response = await issue(tool, params, session)
  if (response.status === 401 && RECIPE.auth.refresh_endpoint) {
    const refreshed = await refresh(session)
    // A single retry, never a loop.
    if (refreshed) response = await issue(tool, params, refreshed)
    if (!refreshed || response.status === 401) {
      throw new ToolError(
        'session_expired',
        'The stored session for "' + RECIPE.name + '" could not be refreshed. Browser relay is required.',
      )
    }
  }
  return response
}

function storedSession(account: string): string | null {
  const override = process.env['RECON_HEADLESS_SESSION']
  if (override) return override
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'recon-headless', '-a', account, '-w'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

async function issue(tool: EjectedTool, params: Record<string, unknown>, session: string) {
  const descriptor = buildRequest(tool, params)
  const response = await fetch(descriptor.url, {
    method: descriptor.method,
    headers: { ...descriptor.headers, cookie: session },
    ...(descriptor.body === undefined ? {} : { body: JSON.stringify(descriptor.body) }),
    redirect: 'manual',
  })
  return { status: response.status, body: await response.json().catch(() => undefined) }
}

async function refresh(session: string): Promise<string | null> {
  try {
    const response = await fetch(new URL(RECIPE.auth.refresh_endpoint as string, RECIPE.base_url), {
      method: 'POST',
      headers: { cookie: session },
    })
    if (!response.ok) return null
    return response.headers.get('set-cookie') ?? session
  } catch {
    return null
  }
}

/**
 * Path parameters substitute into the Endpoint Template; the rest become a query string or a
 * JSON body depending on the method. Identical to recond's \`buildRequest\`.
 */
export function buildRequest(tool: EjectedTool, params: Record<string, unknown>) {
  const remaining: Record<string, unknown> = { ...params }
  delete remaining['confirm']
  delete remaining['raw']

  const resolvedPath = tool.request.path.replace(/\\{(\\w+)\\}/g, (_match: string, name: string) => {
    const value = remaining[name]
    delete remaining[name]
    return encodeURIComponent(String(value ?? ''))
  })

  const url = new URL(resolvedPath, RECIPE.base_url)
  let body: unknown

  if (tool.request.graphql) {
    body = {
      operationName: tool.request.graphql.operation,
      query: tool.request.graphql.document,
      variables: remaining,
    }
  } else if (tool.request.method === 'GET' || tool.request.method === 'HEAD') {
    for (const [key, value] of Object.entries(remaining)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
  } else {
    body = remaining
  }

  return {
    url: url.toString(),
    method: tool.request.method,
    headers: { ...tool.request.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body,
  }
}

/** Trims to the Primary Payload Path and caps the result, exactly as the interpreted client does. */
export function shape(tool: EjectedTool, params: Record<string, unknown>, status: number, body: unknown, durationMs: number): Result {
  let data = body
  let note: string | undefined
  const path = tool.primary_payload_path

  if (params['raw'] !== true && path) {
    const picked = selectPath(body, path)
    if (picked === MISSING) {
      note = 'primary_payload_path "' + path + '" did not resolve; returning the full body.'
    } else {
      data = picked
    }
  }

  const encoded = Buffer.byteLength(json(data), 'utf8')
  if (encoded <= MAX_RESULT_BYTES) {
    return { status, duration_ms: durationMs, data, ...(note === undefined ? {} : { note }) }
  }
  const returned = Buffer.from(json(data), 'utf8').subarray(0, MAX_RESULT_BYTES).toString('utf8')
  return {
    status,
    duration_ms: durationMs,
    data: returned,
    truncated: {
      message: 'Result truncated to ' + String(MAX_RESULT_BYTES) + ' bytes; the untrimmed result was ' + String(encoded) + ' bytes.',
      untrimmed_bytes: encoded,
      returned_bytes: Buffer.byteLength(returned, 'utf8'),
    },
    ...(note === undefined ? {} : { note }),
  }
}

const json = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null'))

export const MISSING = Symbol('missing')

/** The rooted dot/bracket subset of JSONPath that recipes actually record. */
export function selectPath(value: unknown, path: string): unknown {
  let current: unknown = value
  const segments = path
    .replace(/^\\$\\.?/, '')
    .replace(/\\[(\\d+)\\]/g, '.$1')
    .replace(/\\['([^']*)'\\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0)

  for (const segment of segments) {
    if (current === null || current === undefined) return MISSING
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return MISSING
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return MISSING
    const record = current as Record<string, unknown>
    if (!(segment in record)) return MISSING
    current = record[segment]
  }
  return current
}
`
}

function indexModule(recipe: Recipe): string {
  return `${header(recipe)}import { Cli, Openapi, z } from 'incur'
import { execute, ToolError } from './execute.js'
import { RECIPE, TOOLS } from './tools.js'

const cli = Cli.create(RECIPE.name, {
  version: '0.0.0',
  description: 'Tools recorded from ' + RECIPE.base_url + ' (recipe "' + RECIPE.name + '").',
})

// AC-EJT-001.1 — one command per approved tool. Path and required parameters are \`args\`,
// everything else is \`options\`; the schemas were split at eject time.
for (const tool of TOOLS) {
  cli.command(tool.name, {
    description: tool.description,
    args: Openapi.toZod(tool.args_schema) as z.ZodObject<Record<string, z.ZodType>>,
    options: Openapi.toZod(tool.options_schema) as z.ZodObject<Record<string, z.ZodType>>,
    // AC-EJT-001.2 — the output schema comes from the recipe's response contract.
    output: z.object({
      status: z.number(),
      duration_ms: z.number(),
      data: Openapi.toZod(tool.output_schema),
      note: z.string().optional(),
      notice: z.string().optional(),
      truncated: z
        .object({ message: z.string(), untrimmed_bytes: z.number(), returned_bytes: z.number() })
        .optional(),
    }),
    // AC-EJT-001.2 — at least one example, drawn from the tool's stored fixture.
    examples: tool.examples,
    run: async (c: { args: Record<string, unknown>; options: Record<string, unknown>; error: (o: { code: string; message: string; retryable?: boolean }) => never }) => {
      try {
        return await execute(tool, { ...c.args, ...c.options })
      } catch (error) {
        if (error instanceof ToolError) {
          return c.error({ code: error.code, message: error.message, retryable: false })
        }
        throw error
      }
    },
  } as never)
}

cli.serve()
`
}

/**
 * AC-EJT-002.3 — fixture replay. Each approved tool's stored fixture is checked against the
 * schemas the package was emitted with; a fixture that no longer matches exits non-zero and
 * names the tool, so a drifted recipe fails the ejected package's own test rather than a call.
 */
function replayModule(recipe: Recipe): string {
  return `${header(recipe)}import { Openapi } from 'incur'
import { selectPath, MISSING } from './execute.js'
import { TOOLS, type EjectedTool } from './tools.js'

function replay(tool: EjectedTool): string | null {
  if (!tool.fixture) return 'no fixture stored for this tool'

  const example = tool.examples[0]
  if (!example) return 'no example emitted for this tool'
  const args = Openapi.toZod(tool.args_schema).safeParse(example.args)
  if (!args.success) return 'example arguments do not satisfy the argument schema: ' + args.error.message

  const body = tool.fixture.response.body
  const path = tool.primary_payload_path
  const payload = path ? selectPath(body, path) : body
  if (payload === MISSING) return 'primary_payload_path "' + String(path) + '" does not resolve in the fixture'

  const output = Openapi.toZod(tool.output_schema).safeParse(payload)
  if (!output.success) return 'fixture response does not match the output schema: ' + output.error.message
  return null
}

const failures: string[] = []
for (const tool of TOOLS) {
  const failure = replay(tool)
  if (failure === null) {
    console.log('ok    ' + tool.name)
  } else {
    console.log('FAIL  ' + tool.name + ' — ' + failure)
    failures.push(tool.name)
  }
}

if (failures.length > 0) {
  console.error(String(failures.length) + ' of ' + String(TOOLS.length) + ' fixture replays failed: ' + failures.join(', '))
  process.exit(1)
}
console.log(String(TOOLS.length) + ' fixture replays passed')
`
}
