import { test, expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FixtureApp, Douzed, REPO, TSX, launchHelium, waitFor } from '../harness.js'

/**
 * COV_RUN_004.3 — result shaping: trim to the Primary Payload Path, cap at 32 KB, and say so.
 *
 * WHICH LAYER THIS TESTS AND WHY: trimming is not in the daemon. `POST /relay/:recipe/:tool`
 * answers with the target's untouched body; `shapeResult` runs in the CLI process
 * (`packages/cli/src/shape.ts`, called from `RelayClient.call`), which is the same process the
 * MCP server runs in. So the raw relay endpoint would prove nothing about REQ-RUN-004, and every
 * assertion here drives the real client — `douze orders <tool> --format json` — over a real
 * browser relay. The fixture server is still the witness that the full 54 KB really was fetched.
 */
const RECIPE = `
version: 1
name: orders
enabled: true
target:
  base_url: http://127.0.0.1:4180
auth:
  mode: browser_relay
  credential_source:
    - kind: cookie
tools:
  - name: list_orders
    description: Lists every order.
    side_effect: read
    confidence: 0.9
    observations: 3
    approved: true
    fixtures: [list_orders.json]
    request:
      method: GET
      path: /api/orders
    response:
      primary_payload_path: $.data.orders
  - name: get_report
    description: Reports how many orders are open.
    side_effect: read
    confidence: 0.9
    observations: 3
    approved: true
    fixtures: [list_orders.json]
    request:
      method: GET
      path: /api/report
    response:
      primary_payload_path: $.data.summary
  - name: trace_report
    description: Returns the report's raw trace, which is far larger than the cap.
    side_effect: read
    confidence: 0.9
    observations: 3
    approved: true
    fixtures: [list_orders.json]
    request:
      method: GET
      path: /api/report
    response:
      primary_payload_path: $.envelope.trace
`

/** AC-RUN-004.2 — the cap the client applies, mirrored from `packages/cli/src/shape.ts`. */
const MAX_RESULT_BYTES = 32 * 1024

interface ShapedResult {
  status: number
  data: unknown
  note?: string
  truncated?: { message: string; untrimmed_bytes: number; returned_bytes: number }
}

test.describe('COV_RUN_004: Result shaping', () => {
  let app: FixtureApp
  let douzed: Douzed
  let browser: Awaited<ReturnType<typeof launchHelium>>

  test.beforeAll(async () => {
    // A browser launch, an extension handshake, and three CLI processes.
    test.setTimeout(180_000)

    app = new FixtureApp()
    await app.start()
    await app.reset()

    douzed = new Douzed()
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), RECIPE)
    writeFileSync(join(douzed.fixturesDir, 'list_orders.json'), '{"data":{"orders":[]}}')
    await douzed.start()

    browser = await launchHelium()
    await browser.serviceWorker.evaluate(
      ([port, token]) => (globalThis as never as DouzeApi).__douze.connect(Number(port), String(token)),
      [String(douzed.port), douzed.token] as const,
    )

    const page: Page = await browser.context.newPage()
    await page.goto(app.origin)
    // Sign in, exactly as the user would have before recording.
    await page.evaluate(() => fetch('/login', { method: 'POST' }).then((r) => r.json()))
    await waitFor(async () => (await (await douzed.api('/health')).json()).extension_connected, 'extension socket')
    await app.reset()
  })

  test.afterAll(async () => {
    await browser?.dispose()
    await douzed?.stop()
    await app?.stop()
  })

  /** Invokes the tool the way a user would, and parses what the client chose to return. */
  const call = (tool: string, args: string[] = []): Promise<ShapedResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(TSX, [join(REPO, 'packages/cli/src/bin.ts'), 'orders', tool, ...args, '--format', 'json'], {
        env: { ...process.env, DOUZE_HOME: douzed.home },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => (out += chunk))
      child.stderr.on('data', (chunk: Buffer) => (err += chunk))
      child.on('close', () => {
        try {
          resolve(JSON.parse(out) as ShapedResult)
        } catch {
          reject(new Error(`douze orders ${tool} did not return JSON.\nstdout: ${out}\nstderr: ${err}`))
        }
      })
    })

  test('@COV_RUN_004.3 should trim to the primary payload path and return the full body for raw', async () => {
    test.setTimeout(120_000)

    // AC-RUN-004.1 — the ~54 KB body is trimmed to the subtree the recipe points at.
    const trimmed = await call('get_report')
    expect(trimmed.status).toBe(200)
    expect(trimmed.data).toEqual({ open: 2 })
    expect(trimmed.truncated).toBeUndefined()
    // The whole envelope really was fetched; the client, not the target, did the trimming.
    expect(Buffer.byteLength(JSON.stringify(trimmed.data), 'utf8')).toBeLessThan(100)

    const served = (await app.log()).filter((r) => r.path === '/api/report')
    expect(served).toHaveLength(1)

    // AC-INF-005.3 / AC-RUN-004.1 — `raw` returns the untrimmed body. Asserted against a small
    // endpoint so "full body" is a value that can be compared rather than a truncated prefix.
    const shaped = await call('list_orders')
    expect(shaped.data).toEqual([
      { id: 1042, item: 'widget', qty: 2, status: 'open' },
      { id: 1043, item: 'gasket', qty: 1, status: 'open' },
    ])

    const raw = await call('list_orders', ['--raw'])
    expect(raw.data).toEqual({
      data: { orders: [{ id: 1042, item: 'widget', qty: 2, status: 'open' }, { id: 1043, item: 'gasket', qty: 1, status: 'open' }] },
      meta: { total: 2 },
    })
    expect(raw.truncated).toBeUndefined()
  })

  test('@COV_RUN_004.3 should truncate a trimmed result over 32 KB and report the untrimmed size', async () => {
    test.setTimeout(120_000)

    // `$.envelope.trace` selects the 800-entry filler, so the TRIMMED result is itself over the
    // cap — the case AC-RUN-004.2 is about, as distinct from a large envelope that trims small.
    const result = await call('trace_report')

    expect(result.truncated).toBeDefined()
    // The result SAYS it was truncated, in text a chat client will show verbatim.
    expect(result.truncated?.message).toMatch(/truncated/i)
    // And it reports the untrimmed size, which is larger than what came back.
    expect(result.truncated?.untrimmed_bytes).toBeGreaterThan(MAX_RESULT_BYTES)
    expect(result.truncated?.message).toContain(String(result.truncated?.untrimmed_bytes))
    expect(result.truncated?.returned_bytes).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    expect(result.truncated!.returned_bytes).toBeLessThan(result.truncated!.untrimmed_bytes)

    // What came back is the cut prefix of the trace, not the envelope and not the whole thing.
    expect(typeof result.data).toBe('string')
    expect(result.data as string).toContain('"blob"')
    expect(Buffer.byteLength(result.data as string, 'utf8')).toBeLessThanOrEqual(MAX_RESULT_BYTES)
  })
})

interface DouzeApi {
  __douze: { connect(port: number, token: string): Promise<void> }
}
