import { test, expect } from '@playwright/test'
import {
  DISPATCHERS,
  FixtureApp,
  HttpMcp,
  RelayServer,
  launchHelium,
  ordersRecipe,
  pairRelay,
  resultText,
  seedRecipe,
  signIn,
  stopEverything,
  tempDir,
  waitFor,
  type Browser,
} from './harness.js'

// Not a `finally`: a Playwright TIMEOUT abandons the test body, and the fixture app and the relay
// then outlive the run and break the next one's "port is free" wait. This spec also disposes its
// browser mid-run, which is why teardown has to be the kind that only fires once.
test.afterEach(stopEverything)

/**
 * V-015.2 — the cloud pipe, end to end and with no daemon: a hosted connector speaking plain
 * streamable-HTTP MCP, a relay that terminates MCP itself, and one browser extension holding
 * everything else. Replaces `relay/execution.spec.ts` and `remote/connector.spec.ts`, both of
 * which spoke to a daemon.
 *
 * The two assertions that matter most are the ones the WO-015 relay was rebuilt for and which no
 * deleted spec could make: `tools/list` is answered while Chrome is **closed**, and a call made in
 * that state is served rather than refused once the worker comes back inside the wake grace. The
 * browser is therefore launched against a persistent profile and genuinely closed mid-run.
 */
test('a hosted connector lists and calls through the relay, including with Chrome closed', async () => {
  test.setTimeout(240_000)

  const app = new FixtureApp()
  const relay = new RelayServer()
  const profileDir = tempDir('douze-relay-profile-')

  await app.start()
  await app.reset()
  await relay.start()

  let browser: Browser = await launchHelium(undefined, { profileDir })
  await seedRecipe(browser, 'orders', ordersRecipe(app.origin), ['list_orders', 'create_order', 'delete_order'])
  await signIn(browser, app)

  const endpoint = await relay.register()
  await pairRelay(browser, { url: relay.origin, ...endpoint, allow_writes: false })
  await waitFor(() => browser.serviceWorker.evaluate(() => __douze.attached()), 'the relay attachment')

  const mcp = new HttpMcp(`${relay.origin}${endpoint.mcp_path}`)
  await mcp.initialize()
  // The trust table at offer time: reads always, this endpoint did not opt into writes, and no
  // setting puts a destructive tool on a remote surface.
  await expect.poll(() => mcp.tools(), { timeout: 20_000 }).toEqual(['orders_list_orders'])

  await app.reset()
  const first = await mcp.call('orders_list_orders', {})
  expect(first.status).toBe(200)
  expect(resultText(first.body)).toContain('widget')
  expect((await app.log()).filter((entry) => entry.path === '/api/orders')).toHaveLength(1)

  // The path that survives a client freezing its catalogue. See LIST_SKILLS in guards.ts.
  expect(await mcp.allTools()).toEqual(expect.arrayContaining(DISPATCHERS))
  await app.reset()
  const dispatched = await mcp.call('douze_run_skill', {
    skill: 'orders_list_orders',
    arguments: {},
  })
  expect(dispatched.status).toBe(200)
  expect(resultText(dispatched.body)).toContain('widget')
  expect((await app.log()).filter((entry) => entry.path === '/api/orders')).toHaveLength(1)
  // And it is not a way around the table: this endpoint never opted into writes.
  const refused = await mcp.call('douze_run_skill', {
    skill: 'orders_create_order',
    arguments: { item: 'widget', qty: 1 },
  })
  // A refusal is the tool's own failure, so it comes back as the result's error rather than text.
  expect(JSON.stringify(refused.body)).toContain('read-only access')

  // --- Chrome closes -----------------------------------------------------
  await browser.dispose()

  // The whole reason the relay owns sessions: a connector added or polled while the browser is
  // shut still sees its tools instead of looking broken.
  expect(await mcp.tools()).toEqual(['orders_list_orders'])

  await app.reset()
  // Made with nothing attached, so it parks in the wake grace instead of being refused…
  const parked = mcp.call('orders_list_orders', {})
  browser = await launchHelium(undefined, { profileDir })
  // …and the worker re-dials from its stored pairing on its own; nothing pokes it here.
  await waitFor(() => browser.serviceWorker.evaluate(() => __douze.attached()), 'the extension to re-attach')

  const served = await parked
  // Not a race won by a socket that never left: the relay says it lost the extension and then
  // parked a call for it.
  expect(relay.log()).toContain('extension.detached')
  expect(relay.log()).toContain('extension.waking')
  expect(served.status).toBe(200)
  expect(served.body.error).toBeUndefined()
  expect(resultText(served.body)).toContain('widget')
  // The target's own log is the proof that the parked call was dispatched rather than answered
  // from anywhere else.
  expect((await app.log()).filter((entry) => entry.path === '/api/orders')).toHaveLength(1)

  // AC-EXE-003.3 — both calls left a local trace at the trust level they ran under.
  const audit = await browser.serviceWorker.evaluate(() => __douze.calls(5))
  expect(audit[0]).toMatchObject({ tool: 'orders_list_orders', trust: 'remote', outcome: 'ok' })
})
