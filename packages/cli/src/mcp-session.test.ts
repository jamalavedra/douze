import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * COV_RUN_004.1 and COV_RUN_004.2 — a real `douze --mcp` child process, spoken to over stdio in
 * actual JSON-RPC. Nothing here imports the server: if the built binary cannot answer
 * `initialize`, `tools/list`, and `tools/call`, or cannot announce a surface that changed on
 * disk, this fails. That is the whole point of running it out of process.
 */

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENTRY = join(PACKAGE_ROOT, 'src', 'bin.ts')
/** Node 22 cannot run this source directly (`.js` specifiers resolve to `.ts`), so tsx does. */
const RUNNER = join(PACKAGE_ROOT, '..', '..', 'node_modules', '.bin', 'tsx')

/** Every frame the session exchanged, printed on failure and reported as the transcript. */
const transcript: string[] = []

let home: string
let daemon: ChildProcessWithoutNullStreams
let mcp: McpStdioClient

const recipe = (name: string, tools: string): string => `version: 1
name: ${name}
enabled: true
target:
  base_url: https://${name}.test
tools:
${tools}`

const listTool = (recipeName: string): string => `  - name: list
    description: List open items in ${recipeName}
    side_effect: read
    confidence: 0.9
    observations: 4
    approved: true
    fixtures: [list.json]
    request:
      method: GET
      path: /items
      input_schema:
        type: object
        properties:
          status: { type: string, description: Filter by status }
        required: [status]
    response:
      primary_payload_path: $.data
`

const getTool = `  - name: get_issue
    description: Fetch one issue by key
    side_effect: read
    confidence: 0.8
    observations: 2
    approved: true
    fixtures: [list.json]
    request:
      method: GET
      path: /items/{key}
      input_schema:
        type: object
        properties:
          key: { type: string, description: Issue key }
        required: [key]
    response:
      primary_payload_path: $.data
`

beforeAll(async () => {
  expect(existsSync(ENTRY)).toBe(true)

  home = mkdtempSync(join(tmpdir(), 'douze-mcp-'))
  mkdirSync(join(home, 'recipes'), { recursive: true })
  mkdirSync(join(home, 'fixtures'), { recursive: true })
  writeFileSync(join(home, 'fixtures', 'list.json'), '{"data":[{"id":"o-1"}]}')
  writeFileSync(join(home, 'recipes', 'jira.yaml'), recipe('jira', listTool('jira')))
  writeFileSync(join(home, 'recipes', 'linear.yaml'), recipe('linear', listTool('linear')))

  const env = { ...process.env, DOUZE_HOME: home, DOUZE_FOREGROUND: '1', DOUZE_REGISTRY_POLL_MS: '250' }
  // Port 0 keeps the scratch daemon off the fixed default, so a real install can stay up.
  daemon = spawn(RUNNER, [ENTRY, 'start', '--port', '0'], { env, stdio: 'pipe' })
  await waitForHealth(home)

  mcp = new McpStdioClient(spawn(RUNNER, [ENTRY, '--mcp'], { env, stdio: 'pipe' }))
}, 60_000)

afterAll(() => {
  mcp?.kill()
  daemon?.kill('SIGKILL')
  // eslint-disable-next-line no-console -- the transcript is the deliverable of this test file.
  console.log(`\n--- MCP stdio transcript ---\n${transcript.join('\n')}\n---`)
})

describe('douze --mcp over real stdio', () => {
  it('initializes and advertises listChanged (AC-RUN-002.2)', async () => {
    const result = await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: 'douze-acceptance', version: '0.0.0' },
    })
    mcp.notify('notifications/initialized', {})

    expect(result).toMatchObject({ serverInfo: { name: 'douze' } })
    expect((result as { capabilities: { tools?: { listChanged?: boolean } } }).capabilities.tools?.listChanged).toBe(
      true,
    )
  })

  it('lists both recipes’ `list` tools namespaced, renaming neither (COV_RUN_004.1)', async () => {
    const tools = await mcp.tools()
    expect(recipeTools(tools)).toEqual(['jira_list', 'linear_list'])
    // The daemon-lifecycle commands stay off MCP; only the two read-only diagnostics come along.
    expect(tools.map((t) => t.name).sort()).toEqual(['jira_list', 'linear_list', 'sessions', 'status'])

    const jira = tools.find((t) => t.name === 'jira_list')!
    expect(jira.description).toContain('jira')
    expect(jira.inputSchema.required).toEqual(['status'])
    expect(Object.keys(jira.inputSchema.properties).sort()).toEqual(['raw', 'status'])
    expect(jira.inputSchema.properties['status']).toMatchObject({ type: 'string', description: 'Filter by status' })
    expect(jira.annotations).toMatchObject({ readOnlyHint: true })
  })

  it('executes a call through the relay and returns a legible failure (COV_CON_004.1)', async () => {
    const result = (await mcp.request('tools/call', {
      name: 'jira_list',
      arguments: { status: 'open' },
    })) as { isError?: boolean; content: { type: string; text: string }[] }

    // No extension is connected in this harness, so the call reaches the guard and stops there.
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('jira_list')
    expect(result.content[0]?.text).toMatch(/extension is not connected/)
    expect(result.content[0]?.text).toMatch(/did not retry/)
  })

  it('rejects arguments the recipe schema does not allow', async () => {
    const result = (await mcp.request('tools/call', { name: 'jira_list', arguments: {} })) as {
      isError?: boolean
      content: { text: string }[]
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('status')
  })

  it('announces a tool added on disk and lists it next (COV_RUN_004.2)', async () => {
    const changed = mcp.nextNotification('notifications/tools/list_changed')
    writeFileSync(join(home, 'recipes', 'jira.yaml'), recipe('jira', listTool('jira') + getTool))

    await changed

    const tools = await mcp.tools()
    expect(recipeTools(tools)).toEqual(['jira_get_issue', 'jira_list', 'linear_list'])
    expect(tools.find((t) => t.name === 'jira_get_issue')?.inputSchema.required).toEqual(['key'])
  }, 20_000)

  it('announces a removal too, so a withdrawn tool stops being offered', async () => {
    const changed = mcp.nextNotification('notifications/tools/list_changed')
    writeFileSync(join(home, 'recipes', 'linear.yaml'), recipe('linear', '  []\n').replace('tools:\n  []', 'tools: []'))

    await changed

    const tools = await mcp.tools()
    expect(tools.map((t) => t.name)).not.toContain('linear_list')
  }, 20_000)
})

/** Only the `<recipe>_<tool>` entries; `status` and `sessions` are the runtime's own. */
const recipeTools = (tools: McpTool[]): string[] =>
  tools.map((t) => t.name).filter((n) => n.includes('_')).sort()

interface McpTool {
  name: string
  description?: string
  inputSchema: { properties: Record<string, unknown>; required?: string[] }
  annotations?: Record<string, unknown>
}

/** A deliberately small newline-delimited JSON-RPC client — no SDK, so nothing is assumed. */
class McpStdioClient {
  private id = 0
  private buffer = ''
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>()
  private readonly waiters: { method: string; resolve: () => void }[] = []

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.ingest(chunk))
    child.stderr.on('data', (chunk: Buffer) => transcript.push(`stderr: ${chunk.toString().trim()}`))
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.handle(JSON.parse(line) as JsonRpcMessage)
      index = this.buffer.indexOf('\n')
    }
  }

  private handle(message: JsonRpcMessage): void {
    transcript.push(`<-- ${summarize(message)}`)
    if (typeof message.id === 'number') {
      this.pending.get(message.id)?.(message)
      this.pending.delete(message.id)
      return
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i]!.method === message.method) this.waiters.splice(i, 1)[0]!.resolve()
    }
  }

  private send(payload: Record<string, unknown>): void {
    transcript.push(`--> ${summarize(payload as JsonRpcMessage)}`)
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  nextNotification(method: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${method} within 15s`)), 15_000)
      this.waiters.push({
        method,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
      })
    })
  }

  async tools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {})) as { tools: McpTool[] }
    return result.tools
  }

  kill(): void {
    this.child.kill('SIGKILL')
  }
}

interface JsonRpcMessage {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

function summarize(message: JsonRpcMessage): string {
  const text = JSON.stringify(message)
  return text.length > 1400 ? `${text.slice(0, 1400)}…` : text
}

async function waitForHealth(scratchHome: string): Promise<void> {
  const runtimeFile = join(scratchHome, 'douzed.json')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (existsSync(runtimeFile)) {
      const { port } = JSON.parse(readFileSync(runtimeFile, 'utf8')) as { port: number }
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return
      } catch {
        // not up yet
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('douzed never became reachable')
}
