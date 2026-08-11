import { PORT_RANGE as DAEMON_PORT_RANGE } from '@douze/shared'
import { describe, expect, it } from 'vitest'
import { needsPairing, pair, pairAny, PORT_RANGE, reviewUrl, siteTools } from './daemon.js'

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    ({
      ok: status < 400,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch

const refused: typeof fetch = (async () => {
  throw new TypeError('Failed to fetch')
}) as unknown as typeof fetch

describe('needsPairing', () => {
  it('pairs when there is no token at all', () => {
    expect(needsPairing({ token: '', connected: false })).toBe(true)
  })

  it('re-pairs while disconnected: a restarted daemon has reissued its token', () => {
    expect(needsPairing({ token: 'stale', connected: false })).toBe(true)
  })

  it('leaves a live connection alone', () => {
    expect(needsPairing({ token: 'good', connected: true })).toBe(false)
  })
})

describe('pair', () => {
  it('takes the token and the port the daemon reports', async () => {
    expect(await pair(8787, respond({ token: 'tok', port: 9001, version: '0.1.0' }))).toEqual({
      token: 'tok',
      port: 9001,
    })
  })

  it('keeps the port it dialled when the daemon omits one', async () => {
    expect(await pair(8787, respond({ token: 'tok' }))).toEqual({ token: 'tok', port: 8787 })
  })

  it('returns null when the daemon is not running, rather than throwing', async () => {
    expect(await pair(8787, refused)).toBeNull()
  })

  it('returns null on a refusal or a response without a usable token', async () => {
    expect(await pair(8787, respond({}, 403))).toBeNull()
    expect(await pair(8787, respond({ token: '' }))).toBeNull()
    expect(await pair(8787, respond({ token: 42 }))).toBeNull()
  })
})

describe('pairAny', () => {
  // `daemon.ts` imports nothing so the popup bundle stays free of the schema package, so its copy
  // of the ladder can drift from the daemon's. Probing ports the daemon never takes finds nothing.
  it('probes exactly the ports the daemon binds', () => {
    expect(PORT_RANGE).toEqual([...DAEMON_PORT_RANGE])
  })

  /** Answers only on `listening`; every other port refuses, as a closed loopback port does. */
  const daemonOn = (listening: number): { fetchFn: typeof fetch; tried: number[] } => {
    const tried: number[] = []
    const fetchFn = (async (url: string) => {
      const port = Number(new URL(url).port)
      tried.push(port)
      if (port !== listening) throw new TypeError('Failed to fetch')
      return { ok: true, status: 200, json: async () => ({ token: `tok-${port}`, port }) } as Response
    }) as unknown as typeof fetch
    return { fetchFn, tried }
  }

  it('stops at the stored port when the daemon is where we left it', async () => {
    const { fetchFn, tried } = daemonOn(8787)
    expect(await pairAny(8787, fetchFn)).toEqual({ token: 'tok-8787', port: 8787 })
    expect(tried).toEqual([8787])
  })

  it('walks the ladder when something else holds 8787', async () => {
    // RStudio Server's default is exactly 8787, so the daemon lands on 8788 and the extension
    // has to find it there or the popup says "can't reach Claude Desktop" forever.
    const { fetchFn, tried } = daemonOn(8788)
    expect(await pairAny(8787, fetchFn)).toEqual({ token: 'tok-8788', port: 8788 })
    expect(tried).toEqual([8787, 8788])
  })

  it('tries the stored port first and never asks it twice', async () => {
    const { fetchFn, tried } = daemonOn(8791)
    expect(await pairAny(8789, fetchFn)).toEqual({ token: 'tok-8791', port: 8791 })
    expect(tried).toEqual([8789, 8787, 8788, 8790, 8791])
  })

  it('never widens an ephemeral pin into a scan, so a test run cannot find the real daemon', async () => {
    // 8787 is answering here, and pairing with it is exactly what must not happen.
    const { fetchFn, tried } = daemonOn(8787)
    expect(await pairAny(51234, fetchFn)).toBeNull()
    expect(tried).toEqual([51234])
  })

  it('gives up quietly after the whole ladder when nothing is listening', async () => {
    const { fetchFn, tried } = daemonOn(0)
    expect(await pairAny(8787, fetchFn)).toBeNull()
    expect(tried).toEqual(PORT_RANGE)
  })
})

describe('siteTools', () => {
  it('asks about one origin and returns what the daemon knows', async () => {
    let asked = ''
    const fetchFn = ((url: string) => {
      asked = url
      return respond({ tools: [{ name: 'list_issues', description: 'List issues', side_effect: 'read' }] })(url)
    }) as unknown as typeof fetch
    const tools = await siteTools({ port: 8787, token: 'tok' }, 'https://app.linear.app', fetchFn)
    expect(asked).toBe('http://127.0.0.1:8787/api/site-tools?origin=https%3A%2F%2Fapp.linear.app&token=tok')
    expect(tools).toHaveLength(1)
  })

  it('is empty rather than broken when the daemon has nothing to say', async () => {
    expect(await siteTools({ port: 8787, token: 'tok' }, 'https://app.example', refused)).toEqual([])
    expect(await siteTools({ port: 8787, token: 'tok' }, 'https://app.example', respond({}, 404))).toEqual([])
    expect(await siteTools({ port: 8787, token: 'tok' }, 'https://app.example', respond({}))).toEqual([])
  })
})

describe('reviewUrl', () => {
  it('carries the token the user never has to see', () => {
    expect(reviewUrl({ port: 8787, token: 'a/b' }, 's1')).toBe('http://127.0.0.1:8787/review/s1?token=a%2Fb')
  })
})
