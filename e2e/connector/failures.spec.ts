import { test, expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FixtureApp, Douzed, REPO, launchHelium, waitFor, TSX } from '../harness.js'

/**
 * COV_CON_004 — a chat client gives the user no terminal, so the tool RESULT is the only place a
 * failure can explain itself. Every assertion here is on the text a user would read, plus the
 * fixture server's log, which is the only witness that can prove nothing was retried.
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
`

/** Nothing listens on port 1, so a fetch to it fails immediately and deterministically. */
const DEAD_RELAY = 'http://127.0.0.1:1'

test.describe('COV_CON_004: Legible failure', () => {
  let app: FixtureApp
  let douzed: Douzed
  let browser: Awaited<ReturnType<typeof launchHelium>> | undefined

  test.afterEach(async () => {
    await browser?.dispose()
    await douzed?.stop()
    await app?.stop()
  })

  /**
   * Invokes the tool the way a user would: `douze orders list_orders`. stdout and stderr are
   * merged because the assertion is about what the user is shown, not which stream carried it.
   */
  const invokeTool = (env: Record<string, string>): Promise<string> =>
    new Promise((resolve) => {
      const child = spawn(TSX, [join(REPO, 'packages/cli/src/bin.ts'), 'orders', 'list_orders'], {
        env: { ...process.env, ...env },
      })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => (output += chunk))
      child.stderr.on('data', (chunk: Buffer) => (output += chunk))
      child.on('close', () => resolve(output))
    })

  /** Requests the target actually received. The basis for every "no retry" assertion. */
  const targetHits = async (): Promise<number> => (await app.log()).filter((r) => r.path === '/api/orders').length

  test('@COV_CON_004.1 should explain each failure state in the tool result', async () => {
    // Three CLI processes, a real browser, and an extension build — well past the default budget.
    test.setTimeout(240_000)

    app = new FixtureApp()
    await app.start()
    await app.reset()

    // The home exists from construction, so the recipe is staged before douzed ever reads it.
    douzed = new Douzed()
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), RECIPE)
    writeFileSync(join(douzed.fixturesDir, 'list_orders.json'), '{"data":{"orders":[]}}')

    // --- 1. douzed unreachable (AC-CON-004.1) -------------------------------
    /**
     * The CLI STARTS douzed when it is not running (AC-RUN-003.3), so "douzed stopped" is not a
     * state a plain invocation can reach — it would boot one and succeed. The state a user does
     * reach is a relay that cannot be contacted: a pinned `DOUZE_RELAY_URL` never auto-starts, so
     * pointing it at a dead port reproduces exactly the failure REQ-CON-004 is about.
     */
    const unreachable = await invokeTool({ DOUZE_HOME: douzed.home, DOUZE_RELAY_URL: DEAD_RELAY })
    // It says what is wrong and the one action that fixes it, with no terminal involved — the
    // only recourse a chat user has. (It no longer offers `douze start` as a second option: see
    // RELAY_UNREACHABLE_HINT in packages/cli/src/errors.ts.)
    expect(unreachable).toMatch(/isn't running/i)
    expect(unreachable).toMatch(/Quit the app you added Douze to/i)
    expect(unreachable).not.toMatch(/headless/i)
    expect(await targetHits()).toBe(0)

    // --- 2. extension not connected (AC-CON-004.2) --------------------------
    await douzed.start()
    // No browser has been launched, so the daemon holds no extension socket.
    expect((await (await douzed.api('/health')).json()).extension_connected).toBe(false)

    const disconnected = await invokeTool({ DOUZE_HOME: douzed.home })
    expect(disconnected).toContain('extension_disconnected')
    expect(disconnected).toMatch(/extension is not connected/i)
    // It names the target too — a user with several recipes needs to know which one is stuck.
    expect(disconnected).toContain(app.origin)
    expect(disconnected).toMatch(/did not retry/i)
    expect(disconnected).not.toMatch(/headless/i)
    expect(await targetHits()).toBe(0)

    // --- 3. session expired (AC-CON-004.3) ----------------------------------
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

    // reset() clears the log AND restores sessionValid, so the flip has to come after it.
    await app.reset()
    await app.set('sessionValid', false)

    const expired = await invokeTool({ DOUZE_HOME: douzed.home })
    expect(expired).toContain('session_expired')
    // Still names the target, as the host the user knows it by rather than as a URL — a scheme is
    // noise to read out, and a user with several recipes still learns which one is stuck.
    expect(expired).toContain(new URL(app.origin).host)
    expect(expired).toMatch(/sign in again/i)
    expect(expired).toMatch(/did not retry/i)
    expect(expired).not.toMatch(/headless/i)

    // --- 4. no retry, no headless substitute (AC-CON-004.4) -----------------
    // Exactly one request reached the target across all three cases: the single relayed call in
    // case 3. Cases 1 and 2 failed before any request was issued, as asserted above.
    expect(await targetHits()).toBe(1)
  })
})

interface DouzeApi {
  __douze: { connect(port: number, token: string): Promise<void> }
}
