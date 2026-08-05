import { afterEach, describe, expect, it } from 'vitest'
import {
  credentialHeaders,
  isExpired,
  isLoginRedirect,
  loginUrlFor,
  pageStateSources,
  readPageCredentials,
} from './relay.js'

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
