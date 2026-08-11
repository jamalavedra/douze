import { describe, expect, it } from 'vitest'
import { findSurvivingSecrets, redactBody, redactHeaders, redactUrl } from './redact.js'
import { AnnotationSpan, MAX_NOTE_CHARS, isNoiseHost, shouldCapture } from './capture.js'
import { parseRecipe, serializeRecipe } from './recipe-file.js'
import { RemoteRegistration } from './protocol.js'

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
    expect(
      shouldCapture({ ...base, origin: 'https://other.test', response_content_type: 'application/json' }, origins),
    ).toBe(false)
  })

  /**
   * Live capture passes null: the recorded tab is what scoped the request, and the host it called
   * is usually the site's API rather than the site itself. A HAR has no tab to attribute an entry
   * to, so it still names its origins.
   */
  it('keeps another host when the caller has already scoped the request (AC-CAP-004.2)', () => {
    const api = { url: 'https://api.test/v1/x', origin: 'https://api.test' }
    expect(shouldCapture({ ...api, response_content_type: 'application/json' }, null)).toBe(true)
    expect(shouldCapture({ ...api, response_content_type: 'text/css' }, null)).toBe(false)
    expect(
      shouldCapture(
        { url: 'https://x.sentry.io/api/1/envelope', origin: 'https://x.sentry.io', response_content_type: 'application/json' },
        null,
      ),
    ).toBe(false)
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

/**
 * The redactor and the write gate must agree, or an ordinary exchange is refused with no way for
 * anyone to find out why. A developer console hands out API keys under names like
 * `publishableKey`, which no key-based list will ever contain — recording dashboard.openfort.io
 * retained zero exchanges, twice, for exactly this reason.
 */
describe('redaction and the write gate agree (AC-REC-004.2)', () => {
  const cases: [string, unknown][] = [
    ['a prefixed key under an innocuous name', { publishableKey: 'pk_test_4f9a2b7c1d8e3f6a0b5c' }],
    ['a JWT under an innocuous name', { identity: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk' }],
    ['a key nested in an array', { data: [{ id: 'pro_1', secretKey: 'sk_live_9f8e7d6c5b4a39281706' }] }],
  ]

  for (const [what, body] of cases) {
    it(`redacts ${what}, so the gate has nothing to refuse`, () => {
      const redacted = redactBody(body)
      expect(findSurvivingSecrets(redacted)).toEqual([])
      // The value is gone, not merely tolerated.
      expect(JSON.stringify(redacted)).not.toContain('pk_test_')
      expect(JSON.stringify(redacted)).not.toContain('sk_live_')
      expect(JSON.stringify(redacted)).not.toContain('eyJhbGciOi')
    })
  }

  it('redacts a credential in a header nobody listed', () => {
    const out = redactHeaders({ 'x-openfort-key': 'pk_live_1a2b3c4d5e6f7a8b9c0d', accept: 'application/json' })
    expect(findSurvivingSecrets(out)).toEqual([])
    expect(out['accept']).toBe('application/json')
  })

  it('leaves ordinary prose and short values alone', () => {
    const body = { name: 'My project', note: 'the quick brown fox jumps over the lazy dog', count: 3 }
    expect(redactBody(body)).toEqual(body)
  })
})

/**
 * A URL is structure, and judging it as one string made every ordinary REST call read as a
 * credential: long, mixed-alphabet, no spaces, a digit in `/v1/`. The write gate refused 30 of 31
 * exchanges from a real dashboard on that basis, while a 96-character GitHub URL passed because it
 * contained no digit — so the review page showed nothing but GitHub.
 */
describe('URLs are judged part by part (REQ-CAP-005)', () => {
  const ordinary = [
    'https://api.openfort.io/v1/players?limit=20&order=desc',
    'https://api.openfort.io/v1/projects/pro_1a2b3c/policies?expand=transaction_intents',
    'https://dashboard.example.com/api/v2/orders/10482/line-items?include=shipping',
  ]

  for (const url of ordinary) {
    it(`leaves an ordinary API URL alone: ${new URL(url).pathname}`, () => {
      expect(findSurvivingSecrets(url)).toEqual([])
      expect(redactUrl(url)).toBe(url)
    })
  }

  /**
   * A recipe stores `request.path` with no scheme, so the URL branch alone did not cover it and
   * `serializeRecipe` refused to write the recipe the review page had just built — "Couldn't save
   * that" on the one button that matters.
   */
  const paths = [
    '/v1/projects/pro_1a2b3c4d5e6f/policies/pol_9x8y7z6w',
    '/v1/players?limit=20&order=desc&expand=transaction_intents',
    '/v1/projects/{projectId}/policies/{policyId}/rules',
  ]

  for (const path of paths) {
    it(`leaves an ordinary recipe path alone: ${path.slice(0, 40)}`, () => {
      expect(findSurvivingSecrets(path)).toEqual([])
    })
  }

  it('still catches a credential in a bare path', () => {
    expect(findSurvivingSecrets('/v1/s/pk_live_1a2b3c4d5e6f7a8b9c0d/players')).toEqual(['$'])
  })

  const credentials: [string, string][] = [
    ['a prefixed key in the path', 'https://api.example.com/v1/projects/pk_live_1a2b3c4d5e6f7a8b9c0d/players'],
    ['a JWT in the path', 'https://api.example.com/v1/s/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk/x'],
    ['a token in the query', 'https://api.example.com/v1/players?api_key=sk_live_9f8e7d6c5b4a39281706'],
    ['a high-entropy path segment', 'https://api.example.com/v1/session/9f8e7d6c5b4a392817064f9a2b7c1d8e3f6a0b5c1d2e'],
  ]

  for (const [what, url] of credentials) {
    it(`redacts ${what}, and the gate is satisfied afterwards`, () => {
      expect(findSurvivingSecrets(url).length).toBeGreaterThan(0)
      const redacted = redactUrl(url)
      expect(findSurvivingSecrets(redacted)).toEqual([])
      // Twice on the way to disk — the extension, then the store — so it has to settle.
      expect(redactUrl(redacted)).toBe(redacted)
    })
  }
})

/**
 * A URL is persisted whole, so every slot of it is a hiding place. The query and the path were
 * covered; the fragment and the userinfo were not, and an OAuth implicit flow puts the access
 * token in exactly the one the gate could not see.
 */
describe('URL fragment and userinfo (REQ-CAP-005)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'
  const cases: [string, string, string][] = [
    ['an implicit-flow token in the fragment', `https://app.example.com/callback#access_token=${jwt}&state=x`, jwt],
    ['a password in the userinfo', 'https://user:hunter2@api.example.com/v1/orders', 'hunter2'],
    [
      'a bare high-entropy fragment',
      'https://app.example.com/callback#9f8e7d6c5b4a392817064f9a2b7c1d8e3f6a0b5c1d2e',
      '9f8e7d6c5b4a392817064f9a2b7c1d8e3f6a0b5c1d2e',
    ],
  ]

  for (const [what, url, secret] of cases) {
    it(`flags and redacts ${what}`, () => {
      expect(findSurvivingSecrets(url).length).toBeGreaterThan(0)
      const redacted = redactUrl(url)
      expect(decodeURIComponent(redacted)).not.toContain(secret)
      expect(findSurvivingSecrets(redacted)).toEqual([])
      // Twice on the way to disk — the extension, then the store — so it has to settle.
      expect(redactUrl(redacted)).toBe(redacted)
    })
  }

  it('keeps the placeholder in the slot the secret occupied', () => {
    const redacted = new URL(redactUrl(`https://app.example.com/cb#access_token=${jwt}&state=x`))
    expect(new URLSearchParams(redacted.hash.slice(1)).get('access_token')).toBe(`«redacted:string:${jwt.length}»`)
    expect(new URLSearchParams(redacted.hash.slice(1)).get('state')).toBe('x')
    expect(new URL(redactUrl('https://user:hunter2@api.example.com/v1/x')).username).toBe('user')
  })

  it('leaves an ordinary fragment alone', () => {
    const url = 'https://app.example.com/dashboard#/orders/10482'
    expect(findSurvivingSecrets(url)).toEqual([])
    expect(redactUrl(url)).toBe(url)
  })

  it('judges an unparseable URL-shaped string whole instead of failing open', () => {
    const token = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2'
    expect(findSurvivingSecrets(`https://[bad${token}`).length).toBeGreaterThan(0)
  })
})

/**
 * A key is as readable off disk as a value, and `{"<token>": {...}}` is an ordinary shape for a
 * map keyed by session or API key. Both redactors walked values only, so such a secret passed
 * through redaction AND the write gate untouched — the one thing the gate exists to prevent.
 */
describe('secrets in key position (REQ-CAP-005, TR-6)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'

  it('flags a credential-shaped object key', () => {
    expect(findSurvivingSecrets({ [jwt]: { id: 1 } })).toEqual([`$.${jwt} (key)`])
  })

  it('redacts a credential-shaped object key while keeping the shape', () => {
    const redacted = redactBody({ [jwt]: { id: 1 } }) as Record<string, unknown>
    expect(Object.keys(redacted)).toEqual([`«redacted:string:${jwt.length}»`])
    expect(redacted[`«redacted:string:${jwt.length}»`]).toEqual({ id: 1 })
    expect(findSurvivingSecrets(redacted)).toEqual([])
  })

  it('redacts a credential-shaped header name', () => {
    const redacted = redactHeaders({ [jwt]: 'x' })
    expect(Object.keys(redacted)).toEqual([`«redacted:string:${jwt.length}»`])
    expect(findSurvivingSecrets(redacted)).toEqual([])
  })

  /**
   * The same shape in the one slot it was missed. A URL carrying a SET rather than a mapping puts
   * the token in key position — `?<jwt>=1` — and the query loop tested only the value, so the URL
   * came back byte-identical and the gate, which walked `searchParams.values()`, saw nothing.
   */
  it('flags and redacts a credential-shaped query parameter name', () => {
    const url = `https://app.example.com/api/thing?${jwt}=1&page=2`
    expect(findSurvivingSecrets(url)).toEqual(['$'])

    const redacted = redactUrl(url)
    expect(redacted).not.toContain(jwt)
    expect(redacted).toContain('page=2')
    expect(decodeURIComponent(redacted)).toContain(`«redacted:string:${jwt.length}»=1`)
    expect(findSurvivingSecrets(redacted)).toEqual([])
    expect(redactUrl(redacted)).toBe(redacted)
  })

  it('flags and redacts a credential-shaped fragment parameter name', () => {
    const url = `https://app.example.com/cb#${jwt}=1&state=x`
    expect(findSurvivingSecrets(url)).toEqual(['$'])

    const redacted = redactUrl(url)
    expect(decodeURIComponent(redacted)).not.toContain(jwt)
    expect(findSurvivingSecrets(redacted)).toEqual([])
    expect(redactUrl(redacted)).toBe(redacted)
  })

  it('leaves ordinary keys alone', () => {
    const body = { order_id: 10_482, customer_name: 'Ada' }
    expect(redactBody(body)).toEqual(body)
    expect(findSurvivingSecrets(body)).toEqual([])
  })
})

describe('redaction idempotence', () => {
  it('does not re-redact an already-redacted value, preserving the original length', () => {
    const once = redactBody({ password: 'hunter2' }) as Record<string, string>
    const twice = redactBody(once) as Record<string, string>
    expect(once['password']).toBe('«redacted:string:7»')
    // HAR import redacts again over bytes capture already redacted; the length must survive.
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

describe('annotation length (WO-016)', () => {
  const span = (note: string) => ({ id: 'a1', session_id: 's1', note, start_position: 0, end_position: 1 })

  it('refuses a note long enough to make the tool surface undeliverable', () => {
    expect(AnnotationSpan.safeParse(span('cancels the order and refunds the customer')).success).toBe(true)
    expect(AnnotationSpan.safeParse(span('x'.repeat(MAX_NOTE_CHARS))).success).toBe(true)
    // A note becomes sentence one of a tool description verbatim; the attachment protocol caps a
    // description at 4096 characters and a host DROPS a frame it cannot parse, so an unbounded note
    // is a surface that silently never arrives.
    expect(AnnotationSpan.safeParse(span('x'.repeat(MAX_NOTE_CHARS + 1))).success).toBe(false)
    expect(AnnotationSpan.safeParse(span('x'.repeat(5000))).success).toBe(false)
    expect(MAX_NOTE_CHARS).toBeLessThan(4096)
  })

  it('still refuses an empty note', () => {
    expect(AnnotationSpan.safeParse(span('')).success).toBe(false)
  })
})

describe('relay registration (WO-014)', () => {
  it('accepts a build-metadata version and still refuses one carrying a newline', () => {
    expect(RemoteRegistration.safeParse({ daemon_version: '0.1.0+abc' }).success).toBe(true)
    // The log line the relay writes is one line per event, and this is what keeps it that way.
    expect(RemoteRegistration.safeParse({ daemon_version: '0.1.0\nendpoint.registered ep=x' }).success).toBe(false)
    expect(RemoteRegistration.safeParse({ daemon_version: '0.1.0\n' }).success).toBe(false)
    expect(RemoteRegistration.safeParse({ daemon_version: '+'.repeat(33) }).success).toBe(false)
  })
})
