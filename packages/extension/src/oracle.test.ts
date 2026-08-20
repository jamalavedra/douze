import { afterEach, describe, expect, it } from 'vitest'
import { WATCHED, installOracle, worthWatching, type Navigation } from './oracle.js'
import type { ExchangeDraft } from './pipeline.js'

/**
 * The oracle had no test of any kind, which is how its filter came to contradict its own docblock
 * for two releases: the comment said it existed to catch service workers and `sendBeacon`, while
 * `types: ['xmlhttprequest']` excluded every beacon and every form submit. Both capture paths
 * missed those writes at once, silently.
 */
describe('what the completeness oracle watches', () => {
  it('covers the two kinds of write the MAIN-world patch cannot see', () => {
    // sendBeacon is reported as `ping`; a <form method="post"> submit is a navigation.
    expect(WATCHED).toContain('ping')
    expect(WATCHED).toContain('main_frame')
    expect(WATCHED).toContain('sub_frame')
    expect(WATCHED).toContain('xmlhttprequest')
  })

  it('takes a form POST but not the page load around it', () => {
    expect(worthWatching('main_frame', 'POST')).toBe(true)
    expect(worthWatching('sub_frame', 'post')).toBe(true)
    // A page load has no body to observe; it is read from the loaded document instead (REQ-012).
    expect(worthWatching('main_frame', 'GET')).toBe(false)
    expect(worthWatching('sub_frame', 'GET')).toBe(false)
  })

  it('takes every non-navigation regardless of method', () => {
    for (const type of ['xmlhttprequest', 'ping', 'other']) {
      expect(worthWatching(type, 'GET')).toBe(true)
      expect(worthWatching(type, 'POST')).toBe(true)
    }
  })
})

// --- REQ-012, driven through the listeners Chrome would drive ---------------

type Listener = (details: never) => void

const fakeEvent = () => {
  const listeners: Listener[] = []
  return {
    addListener: (listener: Listener) => {
      listeners.push(listener)
    },
    emit: (details: unknown) => {
      for (const listener of listeners) listener(details as never)
    },
  }
}

const globals = globalThis as Record<string, unknown>

/** One request through the oracle's three listeners, as Chrome files it. */
function traffic(type: string, method: string, opts: { finalUrl?: string } = {}) {
  const observed: ExchangeDraft[] = []
  const navigations: Navigation[] = []
  const events = { onBeforeRequest: fakeEvent(), onSendHeaders: fakeEvent(), onCompleted: fakeEvent(), onErrorOccurred: fakeEvent() }
  globals['chrome'] = { webRequest: events }
  installOracle({
    isRecording: (tabId) => tabId === 7,
    onObserved: (draft) => observed.push(draft),
    onNavigation: (navigation) => navigations.push(navigation),
  })
  events.onBeforeRequest.emit({ requestId: 'n1', tabId: 7, type, method, url: 'https://app.test/find/?q=lamp', timeStamp: 1000 })
  // A redirect fires `onBeforeRequest` again for the next leg, same request id, as Chrome does.
  if (opts.finalUrl !== undefined) {
    events.onBeforeRequest.emit({ requestId: 'n1', tabId: 7, type, method: 'GET', url: opts.finalUrl, timeStamp: 1040 })
  }
  events.onCompleted.emit({
    requestId: 'n1',
    tabId: 7,
    type,
    method,
    url: opts.finalUrl ?? 'https://app.test/find/?q=lamp',
    timeStamp: 1090,
    statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
  })
  return { observed, navigations }
}

afterEach(() => {
  delete globals['chrome']
})

describe('a main-frame page load in the recorded tab (REQ-012)', () => {
  it('is reported as a navigation, with the request URL and where it landed', () => {
    const { observed, navigations } = traffic('main_frame', 'GET', { finalUrl: 'https://app.test/results/lamp/' })

    // Never as an observation: an oracle draft has no body, and a document's body is the point.
    expect(observed).toEqual([])
    expect(navigations).toEqual([
      {
        tabId: 7,
        url: 'https://app.test/find/?q=lamp',
        finalUrl: 'https://app.test/results/lamp/',
        status: 200,
        responseHeaders: { 'content-type': 'text/html; charset=utf-8' },
        startedAt: 1000,
        durationMs: 90,
      },
    ])
  })

  it('leaves a sub-frame load alone, and a form POST on its headers-only path', () => {
    expect(traffic('sub_frame', 'GET')).toEqual({ observed: [], navigations: [] })

    const { observed, navigations } = traffic('main_frame', 'POST')
    expect(navigations).toEqual([])
    expect(observed.map((draft) => [draft.method, draft.body_missing, draft.source])).toEqual([
      ['POST', true, 'web_request'],
    ])
  })
})
