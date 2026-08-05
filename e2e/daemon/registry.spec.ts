import { test, expect } from '@playwright/test'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Recond } from '../harness.js'

const recipe = (name: string, description = 'Lists every order.') => `
version: 1
name: ${name}
enabled: true
target:
  base_url: http://127.0.0.1:4180
tools:
  - name: list_orders
    description: ${description}
    side_effect: read
    confidence: 0.9
    observations: 3
    approved: true
    fixtures: [${name}.json]
    request:
      method: GET
      path: /api/orders
`

/** COV_RUN_001 — a broken or drifted recipe must never take the rest of the surface down. */
test.describe('COV_RUN_001: Registry loading', () => {
  let recond: Recond

  test.beforeEach(() => {
    recond = new Recond()
  })
  test.afterEach(() => recond.stop())

  test('@COV_RUN_001.1 should isolate a broken recipe from the rest', async () => {
    // Three recipes on disk, one with an invalid schema.
    for (const name of ['alpha', 'beta']) {
      writeFileSync(join(recond.home, 'recipes', `${name}.yaml`), recipe(name))
      writeFileSync(join(recond.home, 'fixtures', `${name}.json`), '{"data":{"orders":[]}}')
    }
    writeFileSync(join(recond.home, 'recipes', 'broken.yaml'), 'version: 1\nname: broken\ntools: notalist\n')

    await recond.start()
    const state = await (await recond.api('/registry')).json()

    // The two valid recipes serve their tools.
    expect(state.tools.map((t: { qualified_name: string }) => t.qualified_name).sort()).toEqual([
      'alpha_list_orders',
      'beta_list_orders',
    ])
    // The failure is reported by recipe name.
    expect(state.errors).toHaveLength(1)
    expect(state.errors[0].recipe).toBe('broken.yaml')
  })

  test('@COV_RUN_001.2 should expose a fixture-invalid tool as degraded rather than omitting it', async () => {
    writeFileSync(join(recond.home, 'recipes', 'alpha.yaml'), recipe('alpha'))
    // The fixture the recipe references does not exist on disk.
    await recond.start()

    const state = await (await recond.api('/registry')).json()
    expect(state.tools).toHaveLength(1)
    expect(state.tools[0].degraded).toBe(true)
    // The failing fixture must be named.
    expect(state.tools[0].degraded_reason).toContain('alpha.json')
  })
})

/** COV_RUN_002 — the loop that makes description tuning fast. */
test.describe('COV_RUN_002: Hot reload', () => {
  let recond: Recond

  test.beforeEach(async () => {
    recond = new Recond()
    writeFileSync(join(recond.home, 'recipes', 'alpha.yaml'), recipe('alpha'))
    writeFileSync(join(recond.home, 'fixtures', 'alpha.json'), '{"data":{"orders":[]}}')
    await recond.start()
  })
  test.afterEach(() => recond.stop())

  test('@COV_RUN_002.1 should pick up a description edit within 5 seconds', async () => {
    const started = Date.now()
    writeFileSync(join(recond.home, 'recipes', 'alpha.yaml'), recipe('alpha', 'Returns open orders only.'))

    await expect
      .poll(
        async () => (await (await recond.api('/registry')).json()).tools[0]?.tool.description,
        { timeout: 5_000, intervals: [100] },
      )
      .toBe('Returns open orders only.')

    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('@COV_RUN_002.2 should keep serving the last valid version when a reload fails', async () => {
    writeFileSync(join(recond.home, 'recipes', 'alpha.yaml'), 'version: 1\n  bad: [unclosed')

    await expect
      .poll(async () => (await (await recond.api('/registry')).json()).errors.length, { timeout: 5_000 })
      .toBe(1)

    const state = await (await recond.api('/registry')).json()
    // The previously loaded tool continues to serve.
    expect(state.tools).toHaveLength(1)
    expect(state.tools[0].tool.description).toBe('Lists every order.')
    expect(state.errors[0].error).toContain('alpha.yaml')
  })

  test('should stop serving a recipe that is deleted', async () => {
    rmSync(join(recond.home, 'recipes', 'alpha.yaml'))
    await expect
      .poll(async () => (await (await recond.api('/registry')).json()).tools.length, { timeout: 5_000 })
      .toBe(0)
  })
})
