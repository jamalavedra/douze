import { describe, expect, it } from 'vitest'
import { findSurvivingSecrets, redactBody, redactHeaders, redactUrl } from './redact.js'
import { AnnotationSpan, MAX_NOTE_CHARS, isNoiseHost, shouldCapture } from './capture.js'
import { parseRecipe, serializeRecipe } from './recipe-file.js'
import { graphqlHasMutation, MAX_DESCRIPTION, MAX_NAME } from './recipe.js'
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
   * The response content type answers "can inference read this payload?", and this gate used it to
   * answer "is this exchange worth keeping?" — so every write that replied `204 No Content`, or
   * `201 Created` with only a Location header, was dropped before it was stored or counted. GETs
   * were unaffected, because a REST GET essentially always answers JSON, which is exactly the
   * asymmetry that got reported: "some POSTs and PUTs are not being recorded".
   */
  it('keeps a write that answered with no body at all (204, or 201 with a Location)', () => {
    const api = { url: 'https://api.test/v1/orders', origin: 'https://api.test' }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(shouldCapture({ ...api, method }, null)).toBe(true)
    }
    // A bodiless GET is still nothing: no payload to infer from and no action to model.
    expect(shouldCapture({ ...api, method: 'GET' }, null)).toBe(false)
    expect(shouldCapture({ ...api, method: 'HEAD' }, null)).toBe(false)
    // A CORS preflight is OPTIONS/204/no-content-type — the exact shape this rule admits, and
    // every cross-origin API call makes one. Storing them was not just noise: the recipe schema
    // permits six methods, so one stored OPTIONS made inference throw and the review page showed
    // "Couldn't load what this site can do" with every real candidate lost behind it.
    expect(shouldCapture({ ...api, method: 'OPTIONS' }, null)).toBe(false)
    expect(shouldCapture({ ...api, method: 'TRACE' }, null)).toBe(false)
    // The exemption is for an ABSENT body, not for any body a write happens to return: an HTML
    // error page is no more inferable on a POST than on a GET.
    expect(shouldCapture({ ...api, method: 'POST', response_content_type: 'text/html' }, null)).toBe(false)
    // And it does not smuggle a noise host back in.
    expect(shouldCapture({ url: 'https://x.sentry.io/api/1/envelope', origin: 'https://x.sentry.io', method: 'POST' }, null)).toBe(
      false,
    )
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

  /**
   * A recipe arrives as a file someone sent the user, and `buildRequest` resolves `path` against
   * `base_url` with `new URL()` — which drops the base entirely for anything that is not
   * site-relative. Each of these resolved to a host the recipe never declared, on a call carrying
   * the recorded page's cookies and its page-state token.
   */
  describe('a request path may not leave the recipe target (WO-015)', () => {
    const withPath = (path: string): ReturnType<typeof parseRecipe> =>
      parseRecipe(VALID.replace('path: /api/orders', `path: ${JSON.stringify(path)}`), 'x.yaml')

    it.each([
      ['absolute', 'https://evil.example/steal'],
      ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['protocol-relative', '//evil.example/steal'],
      // `new URL('/\\evil.example/x', base)` is `https://evil.example/x`: to the URL parser a
      // backslash is a slash, so a single leading `/` is not on its own enough.
      ['backslash-led', '/\\evil.example/steal'],
      // Tabs and newlines are stripped before parsing, so `/\n//evil` is `//evil`.
      ['newline-smuggled', '/\n//evil.example/steal'],
      ['scheme-only', 'javascript:fetch("https://evil.example")'],
      ['bare relative', 'api/orders'],
    ])('rejects a %s path', (_kind, path) => {
      const result = withPath(path)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('site-relative')
    })

    it('still accepts the paths inference emits', () => {
      expect(withPath('/api/orders').ok).toBe(true)
      expect(withPath('/v1/project/apikey/{project_key}/origins').ok).toBe(true)
      expect(withPath('/').ok).toBe(true)
    })

    /**
     * `page_origin` becomes a `chrome.tabs.create` URL and the tab a MAIN-world script runs in, and
     * it is interpolated into a `chrome.permissions.contains` match pattern that throws when it is
     * malformed — outside the relay's try block, so a bad value surfaced as a raw internal error.
     */
    it('rejects a page_origin that is not a bare http(s) origin', () => {
      const withOrigin = (origin: string): ReturnType<typeof parseRecipe> =>
        parseRecipe(VALID.replace('tools:', `auth:\n  page_origin: ${JSON.stringify(origin)}\ntools:`), 'x.yaml')
      for (const bad of ['javascript:alert(1)', 'https://app.test/dashboard', 'app.test', 'file:///etc', '*']) {
        expect(withOrigin(bad).ok, bad).toBe(false)
      }
      expect(withOrigin('https://app.test').ok).toBe(true)
      expect(withOrigin('http://localhost:3000').ok).toBe(true)
    })

    it('rejects a base_url that is not http(s)', () => {
      for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
        const result = parseRecipe(VALID.replace('https://app.test', url), 'x.yaml')
        expect(result.ok, url).toBe(false)
      }
      expect(parseRecipe(VALID.replace('https://app.test', 'http://localhost:3000'), 'x.yaml').ok).toBe(true)
    })
  })

  it('migrates a versionless recipe and reports the field (AC-REC-001.3)', () => {
    const result = parseRecipe(VALID.replace('version: 1', 'version: 0'), 'old.yaml')
    expect(result.ok).toBe(true)
    expect(result.migrated).toContain('auth')
  })

  /**
   * WO-016 #3 — `description` was unbounded here and capped at 4096 on the wire, and a host drops
   * a frame it cannot parse. `surface.push` carries the whole surface in one frame, so ONE
   * imported recipe with a long description took every tool of every recipe off every hosted
   * client, silently. The recipe schema is the only boundary an imported file crosses.
   */
  describe('model-facing text is bounded (WO-016)', () => {
    const withDescription = (text: string): ReturnType<typeof parseRecipe> =>
      parseRecipe(VALID.replace('description: Lists orders.', `description: ${JSON.stringify(text)}`), 'x.yaml')

    it('refuses a description longer than the wire cap', () => {
      expect(withDescription('x'.repeat(MAX_DESCRIPTION)).ok).toBe(true)
      const refused = withDescription('x'.repeat(MAX_DESCRIPTION + 1))
      expect(refused.ok).toBe(false)
      expect(refused.error).toContain('description')
    })

    it('refuses a degraded_reason long enough to blow the composed description', () => {
      const withReason = (text: string): ReturnType<typeof parseRecipe> =>
        parseRecipe(
          VALID.replace('    request:', `    flags:\n      degraded_reason: ${JSON.stringify(text)}\n    request:`),
          'x.yaml',
        )
      expect(withReason('y'.repeat(1024)).ok).toBe(true)
      expect(withReason('y'.repeat(1025)).ok).toBe(false)
    })

    it('refuses names that would compose past the host cap on <recipe>_<tool>', () => {
      expect(parseRecipe(VALID.replace('name: orders', `name: ${'o'.repeat(MAX_NAME + 1)}`), 'x.yaml').ok).toBe(false)
      expect(parseRecipe(VALID.replace('name: list_orders', `name: ${'l'.repeat(MAX_NAME + 1)}`), 'x.yaml').ok).toBe(
        false,
      )
    })
  })

  /**
   * WO-016 #2 — a GraphQL document is an arbitrary program and `side_effect` beside it is a label
   * the file asserts. Inference derives it from the operation; an imported recipe just says.
   */
  describe('a GraphQL mutation cannot be labelled read (WO-016)', () => {
    const withGraphql = (document: string, sideEffect = 'read'): ReturnType<typeof parseRecipe> =>
      parseRecipe(
        VALID.replace('side_effect: read', `side_effect: ${sideEffect}`).replace('method: GET', 'method: POST').replace(
          '      path: /api/orders',
          `      path: /graphql\n      graphql:\n        operation: op\n        document: ${JSON.stringify(document)}`,
        ),
        'x.yaml',
      )

    it('refuses a mutation the recipe calls read', () => {
      const refused = withGraphql('mutation deleteEverything { deleteAllOrders { id } }')
      expect(refused.ok).toBe(false)
      expect(refused.error).toContain('mutation')
    })

    it('refuses a mutation hidden behind a query in the same document', () => {
      expect(withGraphql('query Safe { me { id } } mutation Nuke { deleteAllOrders { id } }').ok).toBe(false)
    })

    it('allows the same document once it is honestly labelled', () => {
      expect(withGraphql('mutation Nuke { deleteAllOrders { id } }', 'write').ok).toBe(true)
    })

    it('does not refuse a read whose document merely mentions a field called mutation', () => {
      expect(withGraphql('query Audit { account { mutation history } }').ok).toBe(true)
      expect(withGraphql('# mutation Nuke { x }\nquery Audit { me { id } }').ok).toBe(true)
      expect(withGraphql('query Audit($note: String = "mutation Nuke") { me(note: $note) { id } }').ok).toBe(true)
    })

    it('reads the document, not the operation name', () => {
      expect(graphqlHasMutation('mutation { deleteAllOrders { id } }')).toBe(true)
      expect(graphqlHasMutation('query GetMutations { mutations { id } }')).toBe(false)
    })
  })

  describe('REST methods cannot understate their side effects', () => {
    const withMethod = (method: string, sideEffect = 'read'): ReturnType<typeof parseRecipe> =>
      parseRecipe(
        VALID.replace('method: GET', `method: ${method}`).replace('side_effect: read', `side_effect: ${sideEffect}`),
        'x.yaml',
      )

    it('refuses DELETE labelled as a read', () => {
      const result = withMethod('DELETE')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('must be side_effect "destructive"')
    })

    it('refuses DELETE labelled as an ordinary write', () => {
      expect(withMethod('DELETE', 'write').error).toContain('must be side_effect "destructive"')
    })

    it.each(['POST', 'PUT', 'PATCH'])('refuses %s labelled as a read', (method) => {
      const result = withMethod(method)
      expect(result.ok).toBe(false)
      expect(result.error).toContain(`uses ${method}`)
    })

    it('allows a REST write when it is labelled write', () => {
      expect(withMethod('PUT', 'write').ok).toBe(true)
    })
  })

  /**
   * WO-016 #5 — a YAML anchor that includes itself parses into a cyclic object and zod keeps it
   * (`z.unknown()` passes values through by reference). `findSurvivingSecrets` walked it until the
   * stack went, and `RecipeStore.recompute` JSON.stringifies the surface built from it.
   */
  it('rejects a self-referential YAML document with a sentence, not a stack overflow', () => {
    const cyclic = VALID.replace(
      '      path: /api/orders',
      '      path: /api/orders\n      input_schema: &s\n        self: *s',
    )
    const result = parseRecipe(cyclic, 'loop.yaml')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('loop.yaml')
    expect(result.error).toContain('circular reference')
  })

  it('walks a document that reaches the same object twice without recursing forever', () => {
    const shared = { token: '«redacted:string:8»' }
    const cyclic: Record<string, unknown> = { a: shared, b: shared }
    cyclic['self'] = cyclic
    expect(findSurvivingSecrets(cyclic)).toEqual([])
    const leaky: Record<string, unknown> = { nested: { key: 'sk_live_abcdef0123456789ABCDEF' } }
    leaky['self'] = leaky
    expect(findSurvivingSecrets(leaky)).toEqual(['$.nested.key'])
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
/**
 * The promise at the top of redact.ts: detection and removal use the same test, so
 * `findSurvivingSecrets` cannot disagree with what ran before it. When they disagreed the capture
 * gate refused whole exchanges — `credential at $.request_body`, on every X GraphQL call — and a
 * recording came out empty with only a console line to say why.
 *
 * The trap was `=`. `FORM_BODY` matches base64 padding, so an opaque id parsed as a form, the form
 * pass found no secret field, and the string was returned whole — while the gate judged that same
 * string as one value.
 */
describe('the redactor and the gate cannot disagree (REQ-CAP-005)', () => {
  const CASES: Record<string, unknown> = {
    'base64 blob with padding': { feedbackMetadata: 'GjgKGRIXZmVlZGJhY2tfbWV0YWRhdGFfdmFsdWUQARoZChcSFWZl==' },
    'long form body, no secret field': 'debug=true&log=%5B%7B%22event%22%3A%22click%22%7D%5D&sid=99887766554433221100',
    'form body with a secret field': 'user=ada&session=Ab9xY2zQ7mN4pR8sT1vW6uJ0kL5hG3fD2eS7aZ9',
    'jwt under an innocuous key': { clientId: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk' },
    'ordinary payload': { id: 42, name: 'Ada', shipping_address: '10 Downing St' },
  }

  it('never leaves behind something it would then refuse', () => {
    for (const [label, value] of Object.entries(CASES)) {
      // The invariant, not the examples: whatever redaction produces must pass the gate.
      expect(findSurvivingSecrets(redactBody(value)), label).toEqual([])
    }
  })

  /**
   * The trap in making the two agree: they can agree by both being blind. A padded base64 value is
   * form-shaped to a loose regex, so walking it field by field found nothing — and a credential
   * that used to be refused would have been persisted instead. Agreement has to come from both
   * seeing it, not neither.
   */
  it('redacts a padded base64 credential rather than treating it as a form', () => {
    const blob = 'c2tfbGl2ZV9hYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejEyMzQ1Ng=='
    expect(redactBody({ blob })).toEqual({ blob: `«redacted:string:${blob.length}»` })
    // A real form is still a form: one field, and a trailing empty field.
    expect(redactBody('q=hello')).toBe('q=hello')
    expect(redactBody('a=b&c=')).toBe('a=b&c=')
  })

  it('still redacts, rather than passing everything by widening the gate', () => {
    const form = redactBody(CASES['form body with a secret field']) as string
    expect(form).not.toContain('Ab9xY2zQ7mN4pR8sT1vW6uJ0kL5hG3fD2eS7aZ9')
    expect(form).toContain('user=ada')
    expect(JSON.stringify(redactBody(CASES['jwt under an innocuous key']))).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    // And an ordinary payload is untouched, which is what makes a recording worth keeping.
    expect(redactBody(CASES['ordinary payload'])).toEqual({ id: 42, name: 'Ada', shipping_address: '10 Downing St' })
  })
})

/**
 * The one exemption in the write gate, and the only place a credential VALUE may be stored: a header
 * the site hardcodes, which nothing can re-read. Narrow on purpose — matched on the path, so a
 * captured response body cannot smuggle a token past the gate by containing `kind: 'literal'`.
 */
describe('the approved-literal exemption (TR-6)', () => {
  // High entropy on purpose: x.com's own bearer is mostly a run of `A`s and the entropy rule does
  // not flag it at all — it is redacted by HEADER NAME. A hardcoded token that IS flagged is what
  // makes this exemption necessary, so that is what it is tested with.
  const BEARER = 'sk_live_9aF3kQ2mZx7bV1nR8tYuI0pLsDcG4hJw'

  it('lets an approved literal through, at either of the two fields that hold one', () => {
    expect(findSurvivingSecrets({ auth: { credential_source: [{ kind: 'literal', value: BEARER }] } })).toEqual([])
    expect(findSurvivingSecrets({ credentials: [{ header: 'authorization', value: BEARER }] })).toEqual([])
  })

  it('still refuses the same value anywhere else in the same document', () => {
    expect(findSurvivingSecrets({ auth: { token: BEARER } })).toHaveLength(1)
    expect(findSurvivingSecrets({ response_body: { data: { value: BEARER } } })).toHaveLength(1)
    // Not keyed on `kind`, so a payload shaped like a credential source cannot hide one.
    expect(findSurvivingSecrets({ body: { kind: 'literal', value: BEARER } })).toHaveLength(1)
    // And not at an unindexed member of the right name either.
    expect(findSurvivingSecrets({ credential_source: { value: BEARER } })).toHaveLength(1)
  })
})

describe('secrets in key position (REQ-CAP-005, TR-6)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1gFWFOEjXk'

  /**
   * The path it reports names WHERE a secret is, and the caller puts that name in the refusal it
   * sends back — the extension's `gateResult` hands it to a hosted assistant over the relay. So a
   * path carrying the key verbatim made the gate transmit, to a remote party, the exact
   * credential it had just refused to send. It must locate without disclosing.
   */
  it('flags a credential-shaped object key without repeating it', () => {
    const [found, ...rest] = findSurvivingSecrets({ [jwt]: { id: 1 } })
    expect(rest).toEqual([])
    expect(found).toContain('(key)')
    expect(found).not.toContain(jwt)
    expect(found).toBe(`$.«redacted:string:${jwt.length}» (key)`)
  })

  /**
   * A UUID is 36 characters of mixed alphabet with no spaces, and with a resource prefix it is 40
   * — which is exactly the entropy rule's definition of a token. So `id: pol_<uuid>` read as a
   * credential, and the result gate withheld the whole tool result over it: a list endpoint
   * returning six rows told the assistant only that six existed. Identifiers are the most common
   * field in any REST response, so the gate has to be able to see one.
   *
   * A credential that happens to be a UUID is still caught, one layer earlier: redaction matches
   * `session`, `token` and the rest by KEY before any value is judged, and the gate runs on what
   * redaction produced.
   */
  it('lets an identifier through while still redacting a UUID under a secret key', () => {
    const uuid = '4f8a2c1e-9b3d-4a7f-8e21-77c0d5b6a913'
    expect(findSurvivingSecrets({ id: `pol_${uuid}`, policyId: uuid })).toEqual([])

    for (const key of ['session_id', 'sessionId', 'access_token']) {
      const redacted = redactBody({ [key]: uuid }) as Record<string, unknown>
      expect(redacted[key]).toBe(`«redacted:string:${uuid.length}»`)
    }
    // And the rule is narrowed to UUIDs, not to long strings generally.
    expect(findSurvivingSecrets({ id: 'AbC9xY2zQ7mN4pR8sT1vW6uJ0kL5hG3fD2eS7aZ9' })).toHaveLength(1)
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
