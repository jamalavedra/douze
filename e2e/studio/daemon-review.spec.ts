import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Douzed, REPO } from '../harness.js'

/**
 * The review UI is served by the daemon, so the extension can link straight to it and no command
 * has to be run to see it. That moves the token out of a header and into the query string of a
 * URL the browser navigates to, so the guard on it is what this spec is about: with the token the
 * page loads, without it nothing about the session is disclosed.
 *
 * DEPENDS ON LANE A: `GET /review/:sessionId` and `/api/review/:sessionId/*` are the daemon's
 * routes. Until they land this spec fails on a 404, which is the correct signal.
 */
test.describe('Daemon-served review UI', () => {
  let douzed: Douzed
  let sessionId: string

  test.beforeEach(async () => {
    douzed = new Douzed()
    await douzed.start()
    const har = JSON.parse(readFileSync(join(REPO, 'fixtures/orders.har'), 'utf8'))
    const imported = await (
      await douzed.api('/import/har', { method: 'POST', body: JSON.stringify({ har, name: 'orders-har' }) })
    ).json()
    sessionId = imported.session_id
  })

  test.afterEach(() => douzed.stop())

  const review = (query: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${douzed.port}/review/${sessionId}${query}`)

  test('should serve the review page for a captured session', async () => {
    const response = await review(`?token=${douzed.token}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    // A page, not a JSON error body that happened to return 200.
    expect(await response.text()).toMatch(/<html/i)
  })

  test('should disclose nothing about the session without the token', async () => {
    const missing = await review('')
    expect(missing.ok).toBe(false)

    const wrong = await review('?token=not-the-token')
    expect(wrong.ok).toBe(false)
    // The session's origin is the thing worth leaking, so that is what is asserted absent.
    expect(await wrong.text()).not.toContain('app.test')
  })
})
