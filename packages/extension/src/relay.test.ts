import { afterEach, describe, expect, it } from 'vitest'
import {
  credentialHeaders,
  executeRelay,
  isExpired,
  isLoginRedirect,
  loginUrlFor,
  pageStateSources,
  readPageCredentials,
} from './relay.js'

/**
 * A site's API is on a host of its own, so an approved tool can name an origin Chrome never
 * granted us — a denied prompt, or a recipe recorded before Douze asked for the API host at all.
 * What must not happen is a Chrome internal error reaching the chat window instead of an answer.
 */
describe('reading a credential out of page state (AC-EXE-001.3)', () => {
  const withStorage = (entries: Record<string, string>): void => {
    const store = {
      getItem: (k: string) => entries[k] ?? null,
    } as unknown as Storage
    ;(globalThis as Record<string, unknown>)['localStorage'] = store
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['localStorage']
  })

  it('reads a plain storage value', () => {
    withStorage({ token: 'abc123' })
    expect(readPageCredentials(['localStorage.getItem("token")'])).toEqual(['abc123'])
  })

  /**
   * Supabase and friends park the token inside a JSON blob, and this runs in the MAIN world where
   * a strict CSP refuses eval — so the shape has to be modelled, not evaluated.
   */
  it('reads a token nested inside a JSON blob without eval', () => {
    withStorage({ 'sb-abc-auth-token': JSON.stringify({ access_token: 'ey.token.value', user: { id: 'u1' } }) })
    expect(readPageCredentials(['JSON.parse(localStorage.getItem("sb-abc-auth-token")).access_token'])).toEqual([
      'ey.token.value',
    ])
    expect(readPageCredentials(['JSON.parse(localStorage.getItem("sb-abc-auth-token")).user.id'])).toEqual(['u1'])
  })

  it('returns null rather than throwing when the shape has moved', () => {
    withStorage({ 'sb-abc-auth-token': '{"other":1}' })
    expect(readPageCredentials(['JSON.parse(localStorage.getItem("sb-abc-auth-token")).access_token'])).toEqual([null])
    expect(readPageCredentials(['JSON.parse(localStorage.getItem("missing")).access_token'])).toEqual([null])
  })
})

/**
 * CORS forbids `Access-Control-Allow-Origin: *` on a credentialed request, and a token-auth API
 * answers exactly that. Sending cookies to one produced "Failed to fetch" and nothing else — the
 * response was rejected by the browser before any code could see it.
 */
describe('cookies are sent only where they are the credential (AC-EXE-001.1)', () => {
  const call = async (request: Record<string, unknown>): Promise<RequestCredentials> => {
    let mode: RequestCredentials = 'include'
    ;(globalThis as Record<string, unknown>)['chrome'] = {
      permissions: { contains: async () => true },
      tabs: { query: async () => [{ id: 7, url: 'https://dashboard.example.com/x' }] },
      scripting: {
        executeScript: async ({ args }: { args?: unknown[] }) => {
          if (args && args.length > 5) mode = args[5] as RequestCredentials
          return [{ result: { status: 200, headers: {}, body: '{}', url: 'https://api.example.com/v1/x', redirected: false } }]
        },
      },
    }
    await executeRelay(
      {
        id: 'r', origin: 'https://api.example.com', url: 'https://api.example.com/v1/x', method: 'GET',
        headers: {}, credential_source: [], timeout_ms: 1000, ...request,
      } as never,
      { notifyExpired: () => undefined },
    )
    return mode
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['chrome']
  })

  it('omits cookies when a page token is the credential and the call is cross-origin', async () => {
    expect(
      await call({
        execute_origin: 'https://dashboard.example.com',
        credential_source: [{ kind: 'page_state', expression: 'localStorage.getItem("t")', header: 'authorization', prefix: '' }],
      }),
    ).toBe('omit')
  })

  it('sends cookies when the site serves its own API', async () => {
    expect(await call({ origin: 'https://dashboard.example.com', url: 'https://dashboard.example.com/api/x' })).toBe('include')
  })

  it('sends cookies cross-origin when the recipe says cookies are the credential', async () => {
    expect(
      await call({ execute_origin: 'https://dashboard.example.com', credential_source: [{ kind: 'cookie' }] }),
    ).toBe('include')
  })
})

/**
 * A project key in the path is read from the page, like a header — the caller cannot know it, and
 * a redacted placeholder is not an address. `new URL()` percent-encodes the braces on the way, so
 * both spellings have to be substituted.
 */
describe('a path parameter filled from page state (AC-EXE-001.3)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['chrome']
  })

  it('substitutes the encoded placeholder before issuing the request', async () => {
    let issued = ''
    ;(globalThis as Record<string, unknown>)['chrome'] = {
      permissions: { contains: async () => true },
      tabs: { query: async () => [{ id: 3, url: 'https://dashboard.example.com/x' }] },
      scripting: {
        executeScript: async ({ args, func }: { args?: unknown[]; func?: unknown }) => {
          // The first call reads page state; the second issues the request.
          if (String(func).includes('getItem')) return [{ result: ['pk_live_the_key'] }]
          issued = (args?.[0] as string) ?? ''
          return [{ result: { status: 200, headers: {}, body: '{}', url: issued, redirected: false } }]
        },
      },
    }

    await executeRelay(
      {
        id: 'r',
        origin: 'https://api.example.com',
        url: 'https://api.example.com/v1/project/apikey/%7Bproject_key%7D/origins',
        method: 'GET',
        headers: {},
        credential_source: [
          { kind: 'page_state', expression: 'localStorage.getItem("k")', param: 'project_key', prefix: '' },
        ],
        execute_origin: 'https://dashboard.example.com',
        timeout_ms: 1000,
      } as never,
      { notifyExpired: () => undefined },
    )

    expect(issued).toBe('https://api.example.com/v1/project/apikey/pk_live_the_key/origins')
    expect(issued).not.toContain('project_key')
  })
})

describe('an origin the user never granted (AC-EXE-001.1)', () => {
  const request = {
    id: 'r-1',
    origin: 'https://api.example',
    url: 'https://api.example/v1/orders',
    method: 'GET',
    headers: {},
    credential_source: [],
    timeout_ms: 1000,
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['chrome']
  })

  it('names the origin and the fix, and never reaches for a tab', async () => {
    let queriedTabs = false
    ;(globalThis as Record<string, unknown>)['chrome'] = {
      permissions: { contains: async () => false },
      tabs: {
        query: async () => {
          queriedTabs = true
          return []
        },
      },
    }

    const response = await executeRelay(request, { notifyExpired: () => undefined })
    expect(response.ok).toBe(false)
    expect(response.error).toContain('https://api.example')
    expect(response.error).toMatch(/record the site again/i)
    expect(queriedTabs).toBe(false)
  })
})

/**
 * AC-EXE-002.3 — an agent calls a tool with nobody sitting on the target site, so the relay opens
 * a tab of its own. Suppressing the notification for exactly that tab left the common case silent:
 * a signed-out session looked like a tool that had simply stopped working.
 */
describe('an expired session in a tab the relay opened itself (AC-EXE-002.3)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['chrome']
  })

  it('notifies even though the executor tab was ephemeral', async () => {
    let removed = 0
    ;(globalThis as Record<string, unknown>)['chrome'] = {
      permissions: { contains: async () => true },
      tabs: {
        // No tab is open on the origin, so the relay has to create one.
        query: async () => [],
        create: async () => ({ id: 11, url: 'https://app.example/' }),
        remove: async () => void removed++,
        onUpdated: {
          addListener: (fn: (tabId: number, info: { status: string }) => void) => fn(11, { status: 'complete' }),
          removeListener: () => undefined,
        },
      },
      scripting: {
        executeScript: async () => [
          { result: { status: 401, headers: {}, body: '', url: 'https://app.example/api/orders', redirected: false } },
        ],
      },
    }

    const notified: [string, string][] = []
    const response = await executeRelay(
      {
        id: 'r-ephemeral',
        origin: 'https://app.example',
        url: 'https://app.example/api/orders',
        method: 'GET',
        headers: {},
        credential_source: [],
        timeout_ms: 1000,
      } as never,
      { notifyExpired: (origin, loginUrl) => void notified.push([origin, loginUrl]) },
    )

    expect(notified).toEqual([['https://app.example', 'https://app.example/login']])
    expect(response.status).toBe(401)
    expect(removed).toBe(1)
  })
})

describe('isLoginRedirect (AC-EXE-002.1)', () => {
  it('detects a redirect into a login route', () => {
    expect(isLoginRedirect('https://app.example/api/orders', 'https://app.example/login?next=/api')).toBe(true)
    expect(isLoginRedirect('https://app.example/api/orders', 'https://id.example/sso/authorize')).toBe(true)
    expect(isLoginRedirect('https://app.example/api/orders', 'https://app.example/sessions/new')).toBe(true)
  })

  it('does not treat an ordinary redirect as expiry', () => {
    expect(isLoginRedirect('https://app.example/api/orders', 'https://app.example/api/orders/')).toBe(false)
  })

  it('does not treat an unredirected response as expiry', () => {
    expect(isLoginRedirect('https://app.example/api/orders', 'https://app.example/api/orders')).toBe(false)
    expect(isLoginRedirect('https://app.example/api/orders', undefined)).toBe(false)
  })

  it('does not match a path that merely contains the word', () => {
    expect(isLoginRedirect('https://app.example/a', 'https://app.example/api/logins-report')).toBe(false)
  })
})

describe('isExpired', () => {
  it('classifies 401 and 403 as expired', () => {
    expect(isExpired(401, false)).toBe(true)
    expect(isExpired(403, false)).toBe(true)
  })

  it('classifies a login redirect as expired whatever the status', () => {
    expect(isExpired(200, true)).toBe(true)
  })

  it('leaves other failures alone', () => {
    expect(isExpired(500, false)).toBe(false)
    expect(isExpired(200, false)).toBe(false)
  })
})

describe('loginUrlFor (AC-EXE-002.3)', () => {
  it('prefers the login page the target actually redirected to', () => {
    expect(loginUrlFor('https://app.example', 'https://id.example/sso/authorize')).toBe(
      'https://id.example/sso/authorize',
    )
  })

  it('falls back to the target origin', () => {
    expect(loginUrlFor('https://app.example')).toBe('https://app.example/login')
  })
})

describe('credentialHeaders (AC-EXE-001.3)', () => {
  const sources = [
    { kind: 'cookie' as const },
    { kind: 'page_state' as const, expression: "localStorage.getItem('t')", header: 'authorization', prefix: 'Bearer ' },
    { kind: 'page_state' as const, expression: 'window.__CSRF__', header: 'x-csrf-token', prefix: '' },
  ]

  it('attaches each page-state value to its declared header with its prefix', () => {
    expect(credentialHeaders(pageStateSources(sources), ['abc', 'xyz'])).toEqual({
      authorization: 'Bearer abc',
      'x-csrf-token': 'xyz',
    })
  })

  it('omits a header whose value could not be read', () => {
    expect(credentialHeaders(pageStateSources(sources), [null, 'xyz'])).toEqual({ 'x-csrf-token': 'xyz' })
  })

  it('contributes nothing for a cookie-only recipe', () => {
    expect(pageStateSources([{ kind: 'cookie' }])).toEqual([])
  })
})

describe('readPageCredentials', () => {
  const scope = globalThis as unknown as Record<string, unknown>

  afterEach(() => {
    delete scope['__APP__']
    delete scope['localStorage']
  })

  it('walks a dotted path from the page global scope without eval', () => {
    scope['__APP__'] = { auth: { token: 'tok-1' } }
    expect(readPageCredentials(['window.__APP__.auth.token', '__APP__.auth.token'])).toEqual(['tok-1', 'tok-1'])
  })

  it('reads web storage the way the app does', () => {
    scope['localStorage'] = { getItem: (k: string) => (k === 'auth' ? 'tok-2' : null) }
    expect(readPageCredentials(["localStorage.getItem('auth')", 'localStorage.auth'])).toEqual(['tok-2', 'tok-2'])
  })

  it('returns null for a path that does not resolve, rather than throwing', () => {
    expect(readPageCredentials(['__MISSING__.deeply.nested'])).toEqual([null])
  })

  it('returns null when the last-resort eval is blocked or invalid', () => {
    expect(readPageCredentials(['this is not an expression ('])).toEqual([null])
  })
})
