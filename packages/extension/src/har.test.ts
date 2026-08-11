import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import orders from '../../../fixtures/orders.har?raw'
import { findSurvivingSecrets } from '@douze/shared'
import { CaptureStore } from './store.js'
import { importHar } from './har.js'
import { installFakeIndexedDB, uninstallFakeIndexedDB } from './testing.js'

/**
 * The IndexedDB is `testing.ts`'s in-memory fake, shared with `store.test.ts` and
 * `background.test.ts`.
 *
 * The HAR under test is the real `fixtures/orders.har`, read through `?raw` so the daemon's e2e
 * fixture and this one cannot drift; the cases the fixture does not contain (a body-less entry, a
 * credential the write gate still catches) are built inline.
 */

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'

interface Entry {
  startedDateTime?: string
  time?: number
  request: { method: string; url: string; headers?: { name: string; value: string }[]; postData?: { text: string } }
  response: {
    status: number
    headers?: { name: string; value: string }[]
    /** `text` is explicitly optional-or-undefined: a body-less entry is one that omits it. */
    content: { mimeType: string; size?: number; text?: string | undefined; encoding?: string }
  }
}

const json = (url: string, body: unknown, overrides: Partial<Entry['response']['content']> = {}): Entry => ({
  startedDateTime: '2026-08-05T10:00:00.000Z',
  time: 10,
  request: { method: 'GET', url, headers: [] },
  response: {
    status: 200,
    headers: [{ name: 'content-type', value: 'application/json' }],
    content: { mimeType: 'application/json', size: 10, text: JSON.stringify(body), ...overrides },
  },
})

const har = (entries: Entry[]): unknown => ({ log: { version: '1.2', entries } })

describe('HAR import in the extension (T-015.5, REQ-CAP-006)', () => {
  let name = ''
  let counter = 0

  beforeEach(() => {
    installFakeIndexedDB()
    counter += 1
    name = `douze-har-${counter}`
  })

  afterEach(() => {
    uninstallFakeIndexedDB()
  })

  const open = (): Promise<CaptureStore> => CaptureStore.open(name)

  it('keeps only the JSON exchanges of the primary origin', async () => {
    const store = await open()
    const result = await importHar(JSON.parse(orders), 'orders-har', store)

    // The four app.test JSON calls survive; analytics, the stylesheet and the other-origin PNG do not.
    expect(result.imported).toBe(4)
    expect(result.skipped).toBe(3)
    expect(result.refused).toEqual([])

    const detail = await store.session(result.session_id)
    expect(detail?.session.origins).toEqual(['https://app.test'])
    const urls = detail?.exchanges.map((e) => e.url) ?? []
    expect(urls.every((u) => u.startsWith('https://app.test/api/'))).toBe(true)
    expect(urls.some((u) => u.includes('google-analytics') || u.endsWith('.css') || u.endsWith('.png'))).toBe(false)
    expect(detail?.exchanges.every((e) => e.source === 'har')).toBe(true)
  })

  it('turns credentials into placeholders on the way in', async () => {
    const store = await open()
    const result = await importHar(JSON.parse(orders), 'orders-har', store)
    const detail = await store.session(result.session_id)

    const first = detail?.exchanges[0]
    expect(first?.request_headers['authorization']).toMatch(/^«redacted:string:\d+»$/)
    expect(first?.request_headers['cookie']).toMatch(/^«redacted:string:\d+»$/)

    const persisted = JSON.stringify(detail)
    expect(persisted).not.toContain('super-secret-token-value-here')
    expect(persisted).not.toContain('abc123deadbeef')
    // The POST body's `password` field, which only the store's redaction ever saw.
    expect(persisted).not.toContain('hunter2')
    expect(findSurvivingSecrets(detail?.exchanges)).toEqual([])
  })

  it('marks a body-less entry rather than discarding it', async () => {
    const store = await open()
    const result = await importHar(
      har([
        json('https://app.test/api/a', { ok: true }),
        // No `text` at all, and a base64 body that is bytes rather than a payload.
        json('https://app.test/api/b', null, { text: undefined }),
        json('https://app.test/api/c', null, { text: 'iVBORw0KGgo=', encoding: 'base64' }),
      ]),
      'bodyless',
      store,
    )

    expect(result.imported).toBe(3)
    const detail = await store.session(result.session_id)
    const marked = detail?.exchanges.filter((e) => e.body_missing) ?? []
    expect(marked.map((e) => e.url)).toEqual(['https://app.test/api/b', 'https://app.test/api/c'])
    expect(marked.every((e) => e.body_missing_reason === 'har_no_content')).toBe(true)
    expect(marked.every((e) => e.response_body === undefined)).toBe(true)
  })

  /**
   * `response_content_type` is copied from the HAR's `mimeType` and no redactor touches it — the
   * write gate reads the whole record and is what catches this one. The import must neither abort
   * nor hide it.
   */
  it('reports an entry the write gate refuses and imports the rest', async () => {
    const store = await open()
    const poisoned = json('https://app.test/api/token', { ok: true }, { mimeType: `application/json;profile=${JWT}` })
    const result = await importHar(
      har([json('https://app.test/api/a', { a: 1 }), poisoned, json('https://app.test/api/b', { b: 2 })]),
      'poisoned',
      store,
    )

    expect(result.imported).toBe(2)
    expect(result.refused).toHaveLength(1)
    expect(result.refused[0]?.url).toBe('https://app.test/api/token')
    expect(result.refused[0]?.reason).toMatch(/credential at/)

    const detail = await store.session(result.session_id)
    expect(detail?.exchanges.map((e) => e.url)).toEqual(['https://app.test/api/a', 'https://app.test/api/b'])
    expect(JSON.stringify(detail)).not.toContain(JWT)
    // Refusals leave no gap: positions stay contiguous for the annotation spans that index them.
    expect(detail?.exchanges.map((e) => e.position)).toEqual([0, 1])
  })

  it('preserves the order of the file as positions', async () => {
    const store = await open()
    const urls = Array.from({ length: 12 }, (_, i) => `https://app.test/api/step/${i}`)
    const entries = urls.map((url, i) => ({
      ...json(url, { step: i }),
      // Timestamps deliberately descending: file order is what the session must keep.
      startedDateTime: new Date(1_800_000_000_000 - i * 1000).toISOString(),
    }))
    const result = await importHar(har(entries), 'ordered', store)

    expect(result.imported).toBe(12)
    const detail = await store.session(result.session_id)
    expect(detail?.exchanges.map((e) => e.position)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    expect(detail?.exchanges.map((e) => e.url)).toEqual(urls)
  })

  it('refuses to invent a session from a HAR with nothing importable', async () => {
    const store = await open()
    await expect(importHar({ log: { entries: [] } }, 'empty', store)).rejects.toThrow(/no entries/)
    await expect(
      importHar(har([json('https://cdn.test/logo.png', null, { mimeType: 'image/png' })]), 'assets', store),
    ).rejects.toThrow(/no importable JSON exchanges/)
    expect(await store.sessions()).toEqual([])
  })
})
