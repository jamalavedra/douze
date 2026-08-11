import { test, expect } from '@playwright/test'
import {
  FakeHost,
  FixtureApp,
  expose,
  launchHelium,
  ordersRecipe,
  pairRelay,
  seedRecipe,
  signIn,
  waitFor,
  type Browser,
} from './harness.js'

/**
 * T-015.9 — every guard, through the real inbound path, at `remote` trust. Replaces
 * `relay/guards.spec.ts`, which drove douzed's `/relay/...` route.
 *
 * The host here is a liar (see `FakeHost`): it asks for tools it was never offered, which is the
 * only way to reach `checkPolicy`. Both halves of the trust table have to hold — the offer-time
 * filter AND the call-time refusal — because filtering alone is a UI courtesy and a host that
 * lies about what it was sent must not get through.
 *
 * Every refusal is checked against the fixture app's own request log, because that is the only
 * evidence that a guard ran BEFORE dispatch rather than after: an assertion on the error message
 * alone passes just as happily for a tool that ran and then had its answer thrown away.
 */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'

test('the guards refuse before anything reaches the target', async () => {
  test.setTimeout(240_000)

  const app = new FixtureApp()
  const host = new FakeHost()
  let browser: Browser | undefined

  /** Requests the target saw for the tools under test. The executor tab's own page load and the
   * SPA's background polling are not those, and are deliberately not counted. */
  const orderRequests = async (): Promise<string[]> =>
    (await app.log()).filter((entry) => entry.path.startsWith('/api/orders')).map((entry) => `${entry.method} ${entry.path}`)

  try {
    await app.start()
    await app.reset()
    await host.start()

    browser = await launchHelium()
    await seedRecipe(browser, 'orders', ordersRecipe(app.origin), ['list_orders', 'create_order', 'delete_order'])
    await signIn(browser, app)

    // A hosted assistant with no write opt-in.
    const pairing = { url: host.url, token: 'endpoint-token', mcp_path: '/m/secret', allow_writes: false }
    await pairRelay(browser, pairing)
    await waitFor(async () => host.attached, 'the extension to attach to the host')
    await waitFor(async () => host.tools.length > 0, 'the first surface push')

    // --- what a remote host is offered at all ------------------------------
    expect(host.tools.map((tool) => tool.name)).toEqual(['orders_list_orders'])

    // --- a write, refused until opted in -----------------------------------
    await app.reset()
    const write = await host.call('orders_create_order', { item: 'widget', qty: 1 })
    expect(write.error?.code).toBe('trust_refused')
    expect(write.error?.retryable).toBe(false)
    expect(await orderRequests()).toHaveLength(0)

    // --- a destructive tool, refused whatever the host sends ---------------
    const destructive = await host.call('orders_delete_order', { id: 1042, confirm: true })
    expect(destructive.error?.code).toBe('trust_refused')
    // The sentence has to tell a chat user there is no setting to look for.
    expect(destructive.error?.message).toContain('no setting')
    expect(await orderRequests()).toHaveLength(0)

    // The control for both: the same path, same host, same log — a call that IS allowed shows up.
    const allowed = await host.call('orders_list_orders', {})
    expect(allowed.error).toBeUndefined()
    expect(await orderRequests()).toHaveLength(1)

    // --- the write opt-in ---------------------------------------------------
    await pairRelay(browser, { ...pairing, allow_writes: true })
    await waitFor(async () => host.attached, 'the re-dial after the write opt-in')
    await waitFor(async () => host.tools.some((tool) => tool.name === 'orders_create_order'), 'the widened surface')
    // Opting into writes never widens to destructive: nothing puts that on a remote surface.
    expect(host.tools.map((tool) => tool.name)).toEqual(['orders_list_orders', 'orders_create_order'])

    // --- the result secret gate --------------------------------------------
    await app.reset()
    const leaky = await host.call('orders_create_order', { item: 'widget', qty: 1, note: JWT })
    expect(leaky.error?.code).toBe('result_withheld')
    expect(leaky.error?.message).toContain('credential-shaped')
    // This guard is the one that CANNOT run before dispatch — the result is what it reads — so the
    // request did happen, exactly once, and the answer is what was withheld.
    expect(await orderRequests()).toEqual(['POST /api/orders'])
    expect(JSON.stringify(leaky)).not.toContain(JWT)

    // Exempting the tool at this trust level releases it, and nothing else.
    await expose(browser, 'remote', 'orders_create_order', true)
    const exempted = await host.call('orders_create_order', { item: 'widget', qty: 1, note: JWT })
    expect(exempted.error).toBeUndefined()
    expect(exempted.result?.content?.[0]?.text).toContain(JWT)

    // --- a degraded tool ----------------------------------------------------
    // AC-RUN-001.5 — it stays on the surface, says so in the description a chat client selects on,
    // and refuses before dispatch. The Doctor Run that used to set this went with the daemon; a
    // recipe whose fixture is gone reaches the same state, and is the case a user actually hits.
    const stale = ordersRecipe(app.origin).replace('name: orders', 'name: stale').replaceAll('[orders/', '[stale/')
    // Seeded with no fixtures at all, which is what degrades every tool in it.
    await seedRecipe(browser, 'stale', stale, [])
    await waitFor(async () => host.tools.some((tool) => tool.name === 'stale_list_orders'), 'the pushed recipe change')
    expect(host.tools.find((tool) => tool.name === 'stale_list_orders')?.description).toContain(
      'Currently degraded and will refuse to run',
    )
    await app.reset()
    const degraded = await host.call('stale_list_orders', {})
    expect(degraded.error?.code).toBe('tool_degraded')
    expect(await orderRequests()).toHaveLength(0)

    // AC-EXE-003.3 — every one of those left a trace naming what happened.
    const audit = await browser.serviceWorker.evaluate(() => __douze.calls(10))
    expect(audit.map((entry) => entry.outcome)).toEqual([
      'tool_degraded',
      'ok',
      'result_withheld',
      'ok',
      'trust_refused',
      'trust_refused',
    ])
    expect(audit.every((entry) => entry.trust === 'remote')).toBe(true)
  } finally {
    await browser?.dispose()
    await host.close()
    await app.stop()
  }
})
