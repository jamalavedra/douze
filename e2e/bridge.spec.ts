import { test, expect } from '@playwright/test'
import {
  FixtureApp,
  McpClient,
  launchHelium,
  ordersRecipe,
  pairingCode,
  redial,
  resultText,
  seedRecipe,
  signIn,
  spawnBridge,
  stopEverything,
  tempDir,
  waitFor,
} from './harness.js'

// Not a `finally`: a Playwright TIMEOUT abandons the test body, and the bridge — a `tsx` wrapper
// around the process that actually holds the loopback port — survives the run. Teardown kills the
// process GROUP, which is the difference between the port being free next run and not.
test.afterEach(stopEverything)

/**
 * V-015.3 — the local pipe at full trust, driven by a real stdio MCP client over the same
 * newline-delimited JSON-RPC Claude Code speaks. Replaces the four `connector/*.spec.ts` files,
 * which spawned `douze --mcp`.
 *
 * The point of the bridge is the trust difference, so that is what is asserted: a destructive tool
 * is offered here and never remotely (guards.spec.ts holds the other half), it runs with
 * `confirm: true` and is refused without it, and an unpaired process gets none of it — loopback
 * alone is not consent.
 */
test('a stdio client lists and calls through a paired bridge, and an unpaired one is refused', async () => {
  test.setTimeout(240_000)

  const app = new FixtureApp()
  const home = tempDir('douze-bridge-home-')

  await app.start()
  await app.reset()

  const browser = await launchHelium()
  await seedRecipe(browser, 'orders', ordersRecipe(app.origin), ['list_orders', 'create_order', 'delete_order'])
  await signIn(browser, app)

  // A fresh DOUZE_HOME means an unpaired install, so the bridge mints a code and prints it where
  // a human would read it: its own stderr, never a socket.
  const bridge = spawnBridge(home)
  const mcp = new McpClient(bridge.child)
  await mcp.initialize()
  await waitFor(async () => pairingCode(bridge.log()) !== null, 'the bridge to print a pairing code')
  const code = pairingCode(bridge.log())!

  // Nothing is attached yet, so there is nothing to list and nothing to run. The call below is
  // the cold start `connector/cold-start.spec.ts` covered: it waits out the bridge's 40-second
  // wake grace before answering, which is most of this spec's runtime and is deliberate — a
  // bridge that refused instantly would report a browser that is merely booting as gone.
  expect(await mcp.tools()).toEqual([])
  const offline = await mcp.answer('tools/call', { name: 'orders_list_orders', arguments: {} })
  expect(offline.error?.data?.error).toBe('extension_disconnected')

  // --- an unpaired attachment is refused outright ------------------------
  await redial(browser, 'AAAA-BBBB')
  await waitFor(async () => bridge.log().includes('refused an unpaired connection'), 'the bridge to refuse')
  expect(await mcp.tools()).toEqual([])

  // --- paired, with the code the user read off the bridge ----------------
  await redial(browser, code)
  await waitFor(async () => bridge.log().includes('extension attached'), 'the bridge to accept the pairing')
  await expect.poll(() => mcp.tools(), { timeout: 20_000 }).toContain('orders_delete_order')
  // A stdio client is told the surface moved rather than having to poll for it.
  expect(mcp.notified).toContain('notifications/tools/list_changed')
  // Full trust: everything the extension holds, destructive included.
  expect(await mcp.tools()).toEqual(['orders_list_orders', 'orders_create_order', 'orders_delete_order'])

  await app.reset()
  const listed = await mcp.answer('tools/call', { name: 'orders_list_orders', arguments: {} })
  const orders = (JSON.parse(resultText(listed)) as { data: { id: number }[] }).data
  const id = orders[0]!.id

  /** What the target saw for the order under test — the executor tab's own page load is not it. */
  const deletes = async (): Promise<string[]> =>
    (await app.log()).filter((entry) => entry.path === `/api/orders/${id}`).map((entry) => entry.method)

  // --- destructive, without the confirmation -----------------------------
  const unconfirmed = await mcp.answer('tools/call', { name: 'orders_delete_order', arguments: { id } })
  expect(unconfirmed.error?.data?.error).toBe('confirm_required')
  expect(await deletes()).toHaveLength(0)

  // --- destructive, with it ----------------------------------------------
  const confirmed = await mcp.answer('tools/call', { name: 'orders_delete_order', arguments: { id, confirm: true } })
  expect(confirmed.error).toBeUndefined()
  expect(resultText(confirmed)).toContain(String(id))
  expect(await deletes()).toEqual(['DELETE'])

  // The trust the call ran at is the one the extension derived from what it dialled.
  const audit = await browser.serviceWorker.evaluate(() => __douze.calls(3))
  expect(audit[0]).toMatchObject({ tool: 'orders_delete_order', trust: 'local', outcome: 'ok' })
  expect(audit[1]).toMatchObject({ tool: 'orders_delete_order', outcome: 'confirm_required' })
})
