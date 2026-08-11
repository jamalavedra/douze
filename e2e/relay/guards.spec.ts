import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FixtureApp, Douzed } from '../harness.js'

/**
 * COV_EXE_003 — the guards #RelayBridge owns. Each assertion is "and the target saw nothing",
 * which is the whole point: these must fire before a request is issued, not after.
 */
const RECIPE = `
version: 1
name: orders
enabled: true
target:
  base_url: http://127.0.0.1:4180
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
  - name: delete_order
    description: Deletes an order permanently.
    side_effect: destructive
    confidence: 0.8
    observations: 2
    approved: true
    fixtures: [delete_order.json]
    request:
      method: DELETE
      path: /api/orders/{orderId}
      input_schema:
        type: object
        properties:
          orderId: { type: integer }
          confirm: { type: boolean }
        required: [orderId, confirm]
`

test.describe('COV_EXE_003: Call guards', () => {
  let douzed: Douzed
  let app: FixtureApp

  test.beforeEach(async () => {
    app = new FixtureApp()
    await app.start()
    await app.reset()

    douzed = new Douzed()
    writeFileSync(join(douzed.recipesDir, 'orders.yaml'), RECIPE)
    writeFileSync(join(douzed.fixturesDir, 'list_orders.json'), '{"data":{"orders":[]}}')
    writeFileSync(join(douzed.fixturesDir, 'delete_order.json'), '{"data":{"deleted":1}}')
    await douzed.start()
  })

  test.afterEach(async () => {
    await douzed.stop()
    await app.stop()
  })

  const call = async (recipe: string, tool: string, args: Record<string, unknown>) => {
    const res = await douzed.api(`/relay/${recipe}/${tool}`, { method: 'POST', body: JSON.stringify({ args }) })
    return { status: res.status, body: await res.json() }
  }

  test('@COV_EXE_003.1 should reject a destructive call missing confirm before any network request', async () => {
    const { body } = await call('orders', 'delete_order', { orderId: 1042 })

    expect(body.error).toBe('confirm_required')
    expect(body.message).toContain('destructive')
    expect(body.message).toContain('confirm=true')

    // The target saw nothing at all.
    expect(await app.log()).toHaveLength(0)
  })

  test('@COV_EXE_003.2 should reject a degraded tool before any network request', async () => {
    // Mark the tool degraded in its recipe, exactly as a Doctor Run would.
    writeFileSync(
      join(douzed.recipesDir, 'orders.yaml'),
      RECIPE.replace(
        `    fixtures: [list_orders.json]`,
        `    fixtures: [list_orders.json]
    flags:
      degraded: true
      degraded_reason: "response no longer contains $.data.orders"`,
      ),
    )
    await expect
      .poll(async () => (await (await douzed.api('/registry')).json()).tools[0]?.degraded, { timeout: 5_000 })
      .toBe(true)

    const { body } = await call('orders', 'list_orders', {})

    expect(body.error).toBe('tool_degraded')
    // AC-EXE-003.4 — the tool and the detected change both reach the caller, but they are split:
    // the prose names the tool, the site and what to do about it, because Claude reads it out to
    // whoever asked; the change and the developer's route back travel in the structured detail.
    expect(body.message).toContain('orders_list_orders')
    expect(body.message).toContain('127.0.0.1:4180')
    expect(body.change).toBe('response no longer contains $.data.orders')
    expect(body.tool).toBe('orders_list_orders')
    expect(body.fix).toBe('douze doctor orders')

    expect(await app.log()).toHaveLength(0)
  })

  test('should reject an unknown tool without touching the target', async () => {
    const { status, body } = await call('orders', 'nope', {})
    expect(status).toBe(404)
    expect(body.error).toBe('unknown_tool')
    expect(await app.log()).toHaveLength(0)
  })

  test('@COV_CON_004.1 should explain that the extension is disconnected, naming the target', async () => {
    // Guard order matters: confirm is supplied, so this reaches the connectivity check.
    const { body } = await call('orders', 'delete_order', { orderId: 1042, confirm: true })

    expect(body.error).toBe('extension_disconnected')
    expect(body.message).toContain('http://127.0.0.1:4180')
    expect(body.message).toContain('Chrome')
    expect(await app.log()).toHaveLength(0)
  })
})
