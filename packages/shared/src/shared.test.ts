import { describe, expect, it } from 'vitest'
import { findSurvivingSecrets, redactBody, redactHeaders, redactUrl } from './redact.js'
import { isNoiseHost, shouldCapture } from './capture.js'
import { parseRecipe, serializeRecipe } from './recipe-file.js'

describe('redaction (REQ-CAP-005)', () => {
  it('replaces credential headers but keeps type and length (AC-CAP-005.1/.3)', () => {
    const out = redactHeaders({ authorization: 'Bearer abc123', accept: 'application/json' })
    expect(out['authorization']).toBe('«redacted:string:13»')
    expect(out['accept']).toBe('application/json')
  })

  it('replaces secret body fields at any depth (AC-CAP-005.2)', () => {
    const out = redactBody({ user: { password: 'hunter2', name: 'ada' }, items: [{ apiKey: 'k' }] })
    expect(out).toEqual({
      user: { password: '«redacted:string:7»', name: 'ada' },
      items: [{ apiKey: '«redacted:string:1»' }],
    })
  })

  it('matches secret keys across naming styles', () => {
    const out = redactBody({ refresh_token: 'a', refreshToken: 'b', 'api-key': 'c' }) as Record<string, string>
    expect(Object.values(out).every((v) => v.startsWith('«redacted:'))).toBe(true)
  })
})

describe('fixture write gate (AC-REC-004.2)', () => {
  it('catches a JWT hiding under an innocuous key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'
    expect(findSurvivingSecrets({ meta: { value: jwt } })).toEqual(['$.meta.value'])
  })

  it('catches a prefixed secret key', () => {
    expect(findSurvivingSecrets({ k: 'sk_live_abcdef0123456789ABCDEF' })).toEqual(['$.k'])
  })

  it('passes ordinary prose and already-redacted placeholders', () => {
    expect(findSurvivingSecrets({ note: 'transitions an issue to done', h: '«redacted:string:20»' })).toEqual([])
  })
})

describe('noise filtering (REQ-CAP-004)', () => {
  it('excludes analytics hosts and their subdomains (AC-CAP-004.1)', () => {
    expect(isNoiseHost('https://www.google-analytics.com/g/collect')).toBe(true)
    expect(isNoiseHost('https://o1.ingest.sentry.io/api/1/envelope')).toBe(true)
    expect(isNoiseHost('https://dashboard.openfort.io/api/projects')).toBe(false)
  })

  it('excludes non-inferable content types and out-of-scope origins (AC-CAP-004.2)', () => {
    const origins = ['https://app.test']
    const base = { url: 'https://app.test/api/x', origin: 'https://app.test' }
    expect(shouldCapture({ ...base, response_content_type: 'application/json' }, origins)).toBe(true)
    expect(shouldCapture({ ...base, response_content_type: 'text/css' }, origins)).toBe(false)
    expect(shouldCapture({ ...base, origin: 'https://other.test', response_content_type: 'application/json' }, origins)).toBe(false)
  })
})

const VALID = `
version: 1
name: orders
enabled: true
target:
  base_url: https://app.test
tools:
  - name: list_orders
    description: Lists orders.
    side_effect: read
    confidence: 0.9
    observations: 3
    approved: true
    fixtures: [list_orders.json]
    request:
      method: GET
      path: /api/orders
`

describe('recipe format (REQ-REC-001)', () => {
  it('parses a valid recipe', () => {
    const result = parseRecipe(VALID, 'orders.yaml')
    expect(result.ok).toBe(true)
    expect(result.recipe?.tools[0]?.name).toBe('list_orders')
  })

  it('names the recipe file when validation fails (AC-REC-001.4)', () => {
    const result = parseRecipe('version: 1\nname: bad\n', 'bad.yaml')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('bad.yaml')
  })

  it('rejects an approved tool with no fixture (AC-REC-004.1)', () => {
    const result = parseRecipe(VALID.replace('fixtures: [list_orders.json]', 'fixtures: []'), 'x.yaml')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('at least one fixture')
  })

  it('rejects an approved destructive tool with no confirm (AC-REC-002.4)', () => {
    const result = parseRecipe(VALID.replace('side_effect: read', 'side_effect: destructive'), 'x.yaml')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('confirm')
  })

  it('refuses to serialize a recipe carrying a credential (AC-REC-001.2)', () => {
    const recipe = parseRecipe(VALID, 'orders.yaml').recipe!
    expect(() => serializeRecipe(recipe)).not.toThrow()
    recipe.tools[0]!.request.headers = { 'x-trace': 'sk_live_abcdef0123456789ABCDEF' }
    expect(() => serializeRecipe(recipe)).toThrow(/credential/)
  })

  it('migrates a versionless recipe and reports the field (AC-REC-001.3)', () => {
    const result = parseRecipe(VALID.replace('version: 1', 'version: 0'), 'old.yaml')
    expect(result.ok).toBe(true)
    expect(result.migrated).toContain('auth')
  })
})

describe('URL redaction (REQ-CAP-005)', () => {
  it('replaces a credential passed as a query parameter', () => {
    const out = redactUrl('https://app.test/api/x?api_key=abc123&page=2')
    expect(out).toContain('page=2')
    expect(out).not.toContain('abc123')
    expect(decodeURIComponent(out)).toContain('«redacted:string:6»')
  })

  it('replaces a credential-shaped value under an innocuous param name', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'
    expect(redactUrl(`https://app.test/cb?state=${jwt}`)).not.toContain(jwt)
  })

  it('leaves an ordinary URL untouched', () => {
    const url = 'https://app.test/api/orders?status=open&page=2'
    expect(redactUrl(url)).toBe(url)
  })
})

describe('redaction idempotence', () => {
  it('does not re-redact an already-redacted value, preserving the original length', () => {
    const once = redactBody({ password: 'hunter2' }) as Record<string, string>
    const twice = redactBody(once) as Record<string, string>
    expect(once['password']).toBe('«redacted:string:7»')
    // The daemon redacts again after the extension already did; the length must survive.
    expect(twice['password']).toBe('«redacted:string:7»')
  })

  it('is idempotent for headers too', () => {
    const once = redactHeaders({ authorization: 'Bearer abc123' })
    expect(redactHeaders(once)).toEqual(once)
  })
})

describe('review findings — redaction gaps', () => {
  it('redacts sibling secret key names, not just exact matches (#9)', () => {
    const out = redactBody({
      old_password: 'hunter2',
      new_password: 'Tr0ub4dor&3',
      authToken: 'abc',
      sessionId: 'xyz',
      description: 'not a secret',
    }) as Record<string, string>
    for (const key of ['old_password', 'new_password', 'authToken', 'sessionId']) {
      expect(out[key], key).toMatch(/^«redacted:/)
    }
    expect(out['description']).toBe('not a secret')
  })

  it('redacts a form-encoded string body (#2)', () => {
    const out = redactBody('username=ada&password=hunter2') as string
    expect(out).toContain('username=ada')
    expect(out).not.toContain('hunter2')
  })

  it('leaves a non-form string body alone', () => {
    expect(redactBody('just some prose')).toBe('just some prose')
  })
})
