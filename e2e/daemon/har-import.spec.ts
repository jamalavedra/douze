import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Douzed, REPO } from '../harness.js'

/** COV_CAP_006 — a HAR must produce the same shape of session as live capture. */
test.describe('COV_CAP_006: HAR import parity', () => {
  let douzed: Douzed

  test.beforeEach(async () => {
    douzed = new Douzed()
    await douzed.start()
  })

  test.afterEach(() => douzed.stop())

  const importHar = async (har: unknown, name: string) =>
    (await douzed.api('/import/har', { method: 'POST', body: JSON.stringify({ har, name }) })).json()

  test('@COV_CAP_006.1 should import a HAR with filtering and redaction applied', async () => {
    const har = JSON.parse(readFileSync(join(REPO, 'fixtures/orders.har'), 'utf8'))
    const result = await importHar(har, 'orders-har')

    // 4 JSON exchanges from app.test survive; analytics, CSS, and the other-origin PNG do not.
    expect(result.imported).toBe(4)
    expect(result.skipped).toBe(3)

    const detail = await (await douzed.api(`/sessions/${result.session_id}`)).json()
    const urls = detail.exchanges.map((e: { url: string }) => e.url)
    expect(urls.every((u: string) => u.startsWith('https://app.test'))).toBe(true)
    expect(urls.some((u: string) => u.includes('google-analytics'))).toBe(false)
    expect(urls.some((u: string) => u.endsWith('.css'))).toBe(false)

    // AC-CAP-005 — credentials are placeholders, and the originals appear nowhere.
    const first = detail.exchanges[0]
    expect(first.request_headers.authorization).toMatch(/^«redacted:string:\d+»$/)
    expect(first.request_headers.cookie).toMatch(/^«redacted:string:\d+»$/)

    const serialized = JSON.stringify(detail)
    expect(serialized).not.toContain('super-secret-token-value-here')
    expect(serialized).not.toContain('abc123deadbeef')
    expect(serialized).not.toContain('hunter2')
  })

  test('@COV_CAP_006.2 should mark body-less entries rather than dropping them', async () => {
    const har = {
      log: {
        version: '1.2',
        entries: [1, 2].map((n) => ({
          startedDateTime: '2026-08-05T10:00:00.000Z',
          time: 10,
          request: { method: 'GET', url: `https://app.test/api/thing/${n}`, headers: [] },
          response: {
            status: 200,
            headers: [{ name: 'content-type', value: 'application/json' }],
            // No `text` at all — the entry has no response content.
            content: { mimeType: 'application/json', size: 0 },
          },
        })),
      },
    }

    const result = await importHar(har, 'bodyless')
    expect(result.imported).toBe(2)

    const detail = await (await douzed.api(`/sessions/${result.session_id}`)).json()
    expect(detail.exchanges).toHaveLength(2)
    for (const exchange of detail.exchanges) {
      expect(exchange.body_missing).toBe(true)
      expect(exchange.body_missing_reason).toBe('har_no_content')
    }
  })
})
