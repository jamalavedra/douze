import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  FixtureApp,
  HttpMcp,
  REPO,
  RelayServer,
  launchHelium,
  pairRelay,
  resultText,
  stopEverything,
  waitFor,
} from './harness.js'

// Not a `finally`: a Playwright TIMEOUT abandons the test body, and the fixture app and the relay
// then outlive the run and break the next one's "port is free" wait.
test.afterEach(stopEverything)

/**
 * V-015.1 + V-015.2, as one journey: record on a signed-in dashboard, review and approve in the
 * extension's own page, and call the approved tool from a hosted connector — with no daemon on the
 * machine at any point. This replaces `verification/full-app.spec.ts`, whose every step went
 * through douzed; the layers it joins up are now capture → IndexedDB → review page → recipe
 * storage → attachment → relay → MCP.
 *
 * Narrower specs own the edges (relay.spec.ts the detached case, guards.spec.ts the refusals,
 * bridge.spec.ts the local pipe). This one only has to prove they still join.
 */
test('a recorded dashboard becomes a tool a hosted assistant can call, with no daemon', async () => {
  test.setTimeout(240_000)

  // The daemon is not "not running" — it does not exist. Every deleted spec started one.
  expect(existsSync(join(REPO, 'packages/douzed'))).toBe(false)
  expect(existsSync(join(REPO, 'packages/cli'))).toBe(false)

  const app = new FixtureApp()
  const relay = new RelayServer()

  await app.start()
  await app.reset()
  await relay.start()
  const browser = await launchHelium()
  const { serviceWorker, context, extensionId } = browser

  expect(await serviceWorker.evaluate((origin) => __douze.hasOrigin(origin), app.origin)).toBe(true)

  // --- record ------------------------------------------------------------
  const dashboard = await context.newPage()
  await dashboard.goto(app.origin)
  await dashboard.evaluate(() => fetch('/login', { method: 'POST' }).then((response) => response.json()))

  const sessionId = await serviceWorker.evaluate((origin) => __douze.startSession('orders', [origin]), app.origin)
  // startSession reloads the tab itself; the interceptor lands with that load.
  await dashboard.waitForSelector('#list')
  await dashboard.waitForFunction(() => (window as { __douze_interceptor__?: boolean }).__douze_interceptor__ === true)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dashboard.click('#list')
    await dashboard.waitForTimeout(150)
  }
  await dashboard.click('#create')
  await serviceWorker.evaluate(() => __douze.annotate('lists the current orders'))
  await expect
    .poll(() => serviceWorker.evaluate(() => __douze.badgeCount()), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(4)
  const stopped = await serviceWorker.evaluate(() => __douze.stopSession())
  expect(stopped.retained).toBeGreaterThanOrEqual(4)

  const captured = await serviceWorker.evaluate((id) => __douze.recorded(id), sessionId)
  expect(JSON.stringify(captured)).not.toContain('s3ssion-fixture-value')

  // --- review, in the extension's own page -------------------------------
  const review = await context.newPage()
  await review.goto(`chrome-extension://${extensionId}/review.html?session=${sessionId}`)
  await expect.poll(() => review.locator('code.name').allTextContents(), { timeout: 20_000 }).toContain('list_orders')
  /**
   * Everything Douze found is selected, the write included: nobody records a dashboard in order to
   * approve half of it, and what keeps a pre-ticked delete safe is enforcement rather than a tick box
   * (see `checkPolicy` — never destructive for a hosted assistant, never without `confirm` locally).
   *
   * Asserted on the boxes themselves: the surface checks further down cannot tell "never approved"
   * apart from "approved but filtered out", because the pairing below is read-only either way.
   */
  const boxFor = async (tool: string): Promise<boolean> =>
    review.locator('li', { has: review.locator(`code.name:text-is("${tool}")`) }).locator('input').isChecked()
  expect(await boxFor('list_orders')).toBe(true)
  expect(await boxFor('create_order')).toBe(true)
  // And a box can still be turned off, which is the whole point of showing them.
  await review.locator('li', { has: review.locator('code.name:text-is("create_order")') }).locator('input').uncheck()
  expect(await boxFor('create_order')).toBe(false)
  await review.locator('#go').click()
  await expect(review.locator('h1')).toContainText('All set')

  // --- the recipe is in extension storage, not on a disk somewhere -------
  const recipes = await serviceWorker.evaluate(async () => {
    const items = await chrome.storage.local.get(null)
    return Object.entries(items)
      .filter(([key]) => key.startsWith('recipe:'))
      .map(([key, value]) => [key, String(value)] as const)
  })
  expect(recipes.map(([key]) => key)).toEqual(['recipe:orders'])
  const yaml = recipes[0]![1]
  expect(yaml).toContain('list_orders')
  // The write was recorded and written down, but not approved: what the user did not tick is the
  // difference between a tool that exists and a tool that can run. Asserted per tool rather than by
  // counting approvals, because a recording legitimately yields more than one read and all of them
  // are pre-selected.
  const toolBlock = (name: string): string => {
    const start = yaml.indexOf(`- name: ${name}`)
    expect(start, `${name} is missing from the saved recipe`).toBeGreaterThan(-1)
    const next = yaml.indexOf('- name: ', start + 1)
    return yaml.slice(start, next === -1 ? undefined : next)
  }
  expect(toolBlock('list_orders')).toContain('approved: true')
  expect(toolBlock('create_order')).toContain('approved: false')

  // --- the cloud pipe ----------------------------------------------------
  const endpoint = await relay.register()
  await pairRelay(browser, { url: relay.origin, ...endpoint, allow_writes: false })
  await waitFor(() => serviceWorker.evaluate(() => __douze.attached()), 'the extension to attach to the relay')

  const mcp = new HttpMcp(`${relay.origin}${endpoint.mcp_path}`)
  const initialized = await mcp.initialize()
  expect(initialized.result?.['protocolVersion']).toBe('2025-06-18')
  await expect.poll(() => mcp.tools(), { timeout: 20_000 }).toContain('orders_list_orders')
  // Belt and braces: unapproved above, and a read-only pairing would hide it even if it were not.
  expect(await mcp.tools()).not.toContain('orders_create_order')

  await app.reset()
  const called = await mcp.call('orders_list_orders', {})
  expect(called.status).toBe(200)
  expect(called.body.error).toBeUndefined()
  expect(resultText(called.body)).toContain('widget')

  // The only evidence that the call ran inside the signed-in browser rather than anywhere else.
  const requests = (await app.log()).filter((entry) => entry.path === '/api/orders')
  expect(requests).toHaveLength(1)
  expect(requests[0]!.headers['cookie']).toContain('fixture_session=s3ssion-fixture-value')
})
