/**
 * The interceptor is injected as a classic script and exports nothing — exporting a symbol for a
 * test would put an `export` statement in the built `interceptor.js`, which is exactly what
 * `smoke.mjs` forbids. So it is loaded here against a stand-in `window` and driven through the
 * `fetch` it patches, which is the surface the page actually sees.
 *
 * Only the streaming path is covered: the rest of the interceptor is exercised end to end by
 * `smoke.mjs` and the e2e suite, in a real browser where its globals are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageEvent } from './messages.js'

const posted: PageEvent[] = []
let native: (req: Request) => Promise<Response>

const win = {
  fetch: (req: Request) => native(req),
  Request,
  Response,
  XMLHttpRequest: class {
    open(): void {}
    send(): void {}
    setRequestHeader(): void {}
  },
  location: { href: 'https://app.example/' },
  addEventListener(_type: string, handler: (e: unknown) => void) {
    // The bridge announces itself before any page script runs; without it every post is queued.
    handler({ source: win, data: { __douze: 1, dir: 'cs->page', kind: 'ready' } })
  },
  postMessage(message: { payload: PageEvent }) {
    posted.push(message.payload)
  },
}

Object.assign(globalThis, { window: win })
await import('./interceptor.js')

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A response whose body is still open: the server has sent `first` and is not finished. */
function unfinished(first: string): { body: ReadableStream<Uint8Array>; finish: () => void } {
  let close = (): void => {}
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encode(first))
      close = () => ctrl.close()
    },
    pull: () => new Promise<never>(() => {}),
  })
  return { body, finish: () => close() }
}

function complete(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const chunk of chunks) ctrl.enqueue(encode(chunk))
      ctrl.close()
    },
  })
}

/** Chunked with no `content-length`, which is what routes a response through `passthrough`. */
function stream(body: ReadableStream<Uint8Array>): Promise<Response> {
  native = () => Promise.resolve(new Response(body, { headers: { 'content-type': 'text/plain' } }))
  return win.fetch(new Request('https://app.example/search'))
}

const bodies = (): unknown[] => posted.filter((e) => e.type === 'response').map((e) => e.body)

beforeEach(() => {
  posted.length = 0
  // Only the timers: faking the microtask queue as well deadlocks the streams under test.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('streaming capture', () => {
  it('posts what it observed when the page abandons the stream', async () => {
    const res = await stream(unfinished('first page of results').body)
    await (res.body as ReadableStream<Uint8Array>).getReader().read()

    expect(bodies()).toEqual([])
    await vi.advanceTimersByTimeAsync(15_000)
    expect(bodies()).toEqual([{ text: 'first page of results', truncated: true }])
  })

  it('does not post again when an abandoned stream finishes after the watchdog', async () => {
    const open = unfinished('first page of results')
    const res = await stream(open.body)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await vi.advanceTimersByTimeAsync(15_000)

    open.finish()
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(bodies()).toHaveLength(1)
  })

  it('posts the whole body once when the page reads the stream to the end', async () => {
    const res = await stream(complete(['answers ', 'for ', 'reddit']))
    expect(await new Response(res.body).text()).toBe('answers for reddit')

    expect(bodies()).toEqual([{ text: 'answers for reddit', truncated: false }])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(bodies()).toHaveLength(1)
  })

  it('posts once when the page cancels, and the watchdog does not post again after', async () => {
    const res = await stream(unfinished('first page of results').body)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await reader.cancel()

    expect(bodies()).toEqual([{ text: 'first page of results', truncated: true }])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(bodies()).toHaveLength(1)
  })
})
