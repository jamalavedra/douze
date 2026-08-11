/**
 * REQ-CAP-005 — redaction runs in the extension's service worker before an exchange crosses
 * the loopback boundary, and again as a gate on every fixture write (AC-REC-004.2).
 * TR-6: no secret may reach a recipe, fixture, generated source, or log.
 *
 * Two rules, both applied everywhere a value is persisted: a **key** on the credential list, and
 * a **value** that looks like a credential whatever it is called. The second exists because the
 * first cannot be complete — a developer console returns its own API keys under names like
 * `publishableKey`, which no list will ever contain. Detection and removal use the same test
 * (`looksLikeCredential`), so `findSurvivingSecrets` cannot disagree with what ran before it;
 * when they did disagree, an ordinary exchange was refused and the recording silently retained
 * nothing.
 */

/** AC-CAP-005.1 — header names whose values are always replaced. */
export const CREDENTIAL_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-csrf-token',
  'x-xsrf-token',
  'proxy-authorization',
]

/** AC-CAP-005.2 — body keys whose values are always replaced, matched case-insensitively. */
export const SECRET_FIELDS = [
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'refresh_token',
  'access_token',
  'client_secret',
  'private_key',
  'session',
  'credential',
]

export interface RedactionConfig {
  headers: string[]
  fields: string[]
}

export const defaultRedaction = (): RedactionConfig => ({
  headers: [...CREDENTIAL_HEADERS],
  fields: [...SECRET_FIELDS],
})

/**
 * AC-CAP-005.3 — the placeholder carries the original type and length so schema inference
 * still sees a string of the right shape, but never the value itself.
 */
export function placeholder(value: unknown): string {
  if (typeof value === 'string') return `«redacted:string:${value.length}»`
  if (typeof value === 'number') return `«redacted:number»`
  if (typeof value === 'boolean') return `«redacted:boolean»`
  if (value === null) return `«redacted:null»`
  return `«redacted:${Array.isArray(value) ? 'array' : typeof value}»`
}

const isPlaceholder = (v: unknown): boolean => typeof v === 'string' && v.startsWith('«redacted:')

/**
 * Substring match after normalisation, not equality. Real payloads carry `old_password`,
 * `new_password`, `authToken`, `sessionId`, `tokens` — an exact match misses every one of them,
 * and the entropy gate cannot save a human-chosen password.
 */
function matches(name: string, list: string[]): boolean {
  const normalized = name.toLowerCase().replace(/[-_]/g, '')
  return list.some((entry) => normalized.includes(entry.toLowerCase().replace(/[-_]/g, '')))
}

/**
 * Redaction runs twice by design — once in the extension's service worker, once again in the
 * daemon, which also ingests HAR files. It must therefore be idempotent: re-redacting a
 * placeholder would replace it with a placeholder of the placeholder, destroying the original
 * length that AC-CAP-005.3 requires schema inference to keep.
 */
export function redactHeaders(
  headers: Record<string, string>,
  config: RedactionConfig = defaultRedaction(),
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const secret = matches(name, config.headers) || looksLikeCredential(value)
    // A credential-shaped header NAME is redacted in place: the name is as persistent as the
    // value, and the gate refuses the exchange over it either way.
    const key = looksLikeCredential(name) ? placeholder(name) : name
    out[key] = secret && !isPlaceholder(value) ? placeholder(value) : value
  }
  return out
}

/**
 * A form-encoded body arrives as a string, so the object walk below never sees its fields.
 * `application/x-www-form-urlencoded` is explicitly allowed by the capture filter, so
 * `username=ada&password=hunter2` would otherwise be persisted verbatim (AC-CAP-005.2).
 */
const FORM_BODY = /^(?:[\w.[\]%+-]+=[^&]*)(?:&[\w.[\]%+-]+=[^&]*)*$/

export function redactFormBody(body: string, config: RedactionConfig = defaultRedaction()): string {
  const params = new URLSearchParams(body)
  let changed = false
  // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before params.set() mutates during iteration
  for (const [key, value] of [...params.entries()]) {
    if ((matches(key, config.fields) || looksLikeCredential(value)) && !isPlaceholder(value)) {
      params.set(key, placeholder(value))
      changed = true
    }
  }
  return changed ? params.toString() : body
}

/** Walks any JSON value, replacing values whose *key* matches the secret-field list. */
export function redactBody(body: unknown, config: RedactionConfig = defaultRedaction()): unknown {
  if (typeof body === 'string' && body.includes('=') && FORM_BODY.test(body)) {
    return redactFormBody(body, config)
  }
  // A credential under an innocuous key name — `publishableKey`, `clientId`, an id field holding
  // a JWT. Redacting by key alone left these in place and the write gate then REFUSED the whole
  // exchange, so a dashboard that hands out API keys (which is most developer consoles) recorded
  // nothing at all and said nothing about why. The gate's own test is the redactor's test now, so
  // the two cannot disagree: a value it would catch is replaced here first, and the placeholder
  // keeps the type and length that schema inference reads.
  if (typeof body === 'string') {
    if (isPlaceholder(body)) return body
    // A JSON string is redacted field by field and handed back as a string, so a body that was
    // never parsed keeps every field it had, minus any secret inside it.
    if (JSONISH.test(body)) {
      const parsed = parseJson(body)
      if (parsed !== undefined) return JSON.stringify(redactBody(parsed, config))
    }
    return looksLikeCredential(body) ? placeholder(body) : body
  }
  if (Array.isArray(body)) return body.map((item) => redactBody(item, config))
  if (body !== null && typeof body === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      // The key is redacted for the same reason the value is: `{"<jwt>": {...}}` persists the
      // token just as readably as `{"token": "<jwt>"}`, and the shape survives the replacement.
      const name = looksLikeCredential(key) ? placeholder(key) : key
      out[name] =
        matches(key, config.fields) && !isPlaceholder(value) ? placeholder(value) : redactBody(value, config)
    }
    return out
  }
  return body
}

/**
 * REQ-CAP-005 — a URL is persisted whole, so a credential passed as a query parameter would
 * bypass header and body redaction entirely. Apps really do this (`?api_key=`, `?token=`), so
 * the query string gets the same key-based treatment as a body.
 */
export function redactUrl(url: string, config: RedactionConfig = defaultRedaction()): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  let changed = false
  // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before params.set() mutates during iteration
  for (const [key, value] of [...parsed.searchParams.entries()]) {
    // `isPlaceholder` matters because this runs twice on the way to disk — once in the extension,
    // once in the store — and re-redacting a placeholder would report the placeholder's own length.
    const secret = (matches(key, config.fields) || looksLikeCredential(value)) && !isPlaceholder(value)
    // The key is redacted for the same reason an object key and a header name are: `?<jwt>=1` is
    // as readable off disk as `?token=<jwt>`, and a token really does arrive in key position when
    // a URL carries a set rather than a mapping.
    const name = !isPlaceholder(key) && looksLikeCredential(key) ? placeholder(key) : key
    if (!secret && name === key) continue
    if (name !== key) parsed.searchParams.delete(key)
    parsed.searchParams.set(name, secret ? placeholder(value) : value)
    changed = true
  }
  // A key in the path, not the query — `/v1/projects/pk_live_…/players`. The write gate reads the
  // whole URL, so a segment it would catch has to be replaced here or the exchange is refused.
  const segments = parsed.pathname.split('/').map((segment) => {
    if (!segment || isPlaceholder(segment) || !looksLikeCredential(segment)) return segment
    changed = true
    return placeholder(segment)
  })
  if (changed) parsed.pathname = segments.join('/')

  // Userinfo — `https://user:hunter2@host`. The password is a credential by position, whatever it
  // looks like, so it is replaced unconditionally; a username is one only when it holds a token,
  // which is how `https://<pat>@github.com/…` arrives.
  const password = decodePart(parsed.password)
  if (password && !isPlaceholder(password)) {
    parsed.password = placeholder(password)
    changed = true
  }
  const username = decodePart(parsed.username)
  if (username && !isPlaceholder(username) && looksLikeCredential(username)) {
    parsed.username = placeholder(username)
    changed = true
  }

  // The fragment never leaves the browser, but the URL is persisted whole and an OAuth implicit
  // flow returns its access token there: `#access_token=…&state=x`.
  const fragment = fragmentParams(parsed.hash)
  if (fragment) {
    let hashChanged = false
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before set() mutates during iteration
    for (const [key, value] of [...fragment.entries()]) {
      const secret = (matches(key, config.fields) || looksLikeCredential(value)) && !isPlaceholder(value)
      const name = !isPlaceholder(key) && looksLikeCredential(key) ? placeholder(key) : key
      if (!secret && name === key) continue
      if (name !== key) fragment.delete(key)
      fragment.set(name, secret ? placeholder(value) : value)
      hashChanged = true
    }
    if (hashChanged) {
      parsed.hash = fragment.toString()
      changed = true
    }
  } else {
    const opaque = decodePart(parsed.hash.slice(1))
    if (opaque && !isPlaceholder(opaque) && looksLikeCredential(opaque)) {
      parsed.hash = placeholder(opaque)
      changed = true
    }
  }
  return changed ? parsed.toString() : url
}

/**
 * AC-REC-004.2 — the write gate, and defence in depth rather than the first line of it. Anything
 * it detects — JWTs, bearer prefixes, prefixed keys, long high-entropy tokens — is already
 * replaced by `redactBody`/`redactHeaders`/`redactUrl`, which share this exact test. What it
 * still catches is a document that reached a persistence boundary without passing through them.
 * Returns the JSON paths of anything suspicious; an empty array means the write may proceed.
 */
export function findSurvivingSecrets(value: unknown, path = '$'): string[] {
  if (isPlaceholder(value)) return []
  if (typeof value === 'string') return looksLikeCredential(value) ? [path] : []
  if (Array.isArray(value)) return value.flatMap((v, i) => findSurvivingSecrets(v, `${path}[${i}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      // A key is as readable off disk as a value. `{"<jwt>": {...}}` is an ordinary shape for a
      // map keyed by session or token, and walking values alone let one through both this gate
      // and the redactors, which is the one thing this function exists to make impossible.
      ...(looksLikeCredential(k) ? [`${path}.${k} (key)`] : []),
      ...findSurvivingSecrets(v, `${path}.${k}`),
    ])
  }
  return []
}

const JWT = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/
const BEARER = /^(bearer|basic)\s+\S{8,}/i
/** Openfort and Stripe-style prefixed keys, plus generic `sk_`/`pk_` secrets. */
const PREFIXED_KEY = /\b(sk|pk|rk)_(test|live|prod)?_?[A-Za-z0-9]{16,}\b/

/** Values that are structure rather than tokens, and must be judged part by part. */
const URLISH = /^https?:\/\//i
/** A recipe's `request.path`, and every relative URL a capture carries. */
const PATHISH = /^\//
/** A serialised object or array, which carries its own structure to be judged by. */
const JSONISH = /^\s*[{[]/

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function looksLikeCredential(value: string): boolean {
  if (JWT.test(value) || BEARER.test(value) || PREFIXED_KEY.test(value)) return true
  /**
   * A URL is judged by its parts, never as one string. `https://api.example/v1/players?limit=20`
   * is long, mixed-alphabet, space-free and carries a digit — which is the entropy rule's entire
   * definition of a token, so every ordinary REST call read as a credential. That refused 30 of
   * 31 exchanges from a real dashboard while letting a 96-character GitHub URL through, because
   * that one happened to contain no digit. The review page then showed nothing but GitHub.
   */
  if (URLISH.test(value) || PATHISH.test(value)) {
    const parsed = parseUrl(value)
    // An unparseable URL-shaped string falls through to be judged whole — parts can't be trusted,
    // so the gate must not fail open on it.
    if (parsed) {
      // A userinfo password is a credential by position — `https://user:hunter2@host` carries one
      // that no entropy rule will ever flag, and the URL is persisted whole.
      const password = decodePart(parsed.password)
      if (password && !isPlaceholder(password)) return true
      return urlParts(parsed).some((part) => looksLikeCredential(part))
    }
  }
  /**
   * A serialised JSON document, judged by its fields for the same reason a URL is judged by its
   * segments. `{"provider":"guest","enabled":true}` is long, space-free and mixed-alphabet, so the
   * entropy rule replaced entire request bodies with one placeholder — losing every field a write
   * tool needed to take arguments.
   */
  if (JSONISH.test(value)) {
    const parsed = parseJson(value)
    if (parsed !== undefined) return findSurvivingSecrets(parsed).length > 0
  }
  // A long, unbroken, mixed-alphabet run with no spaces reads as a token rather than prose.
  if (value.length >= 40 && !/\s/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)) {
    return shannonEntropy(value) > 3.5
  }
  return false
}

const decodePart = (part: string): string => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/**
 * The base makes a bare path parse: a recipe stores `request.path` on its own, and
 * `/v1/projects/pro_1a2b3c/policies` is long, mixed-alphabet and space-free, so judging it whole
 * refused to write the very recipe the review page had just built.
 */
const parseUrl = (url: string): URL | null => {
  try {
    return new URL(url, 'http://parts.invalid')
  } catch {
    return null
  }
}

/** `#access_token=…&state=x`, or null for an opaque fragment that is one value rather than a set. */
const fragmentParams = (hash: string): URLSearchParams | null => {
  const fragment = hash.slice(1)
  return fragment.includes('=') ? new URLSearchParams(fragment) : null
}

/**
 * Path segments, query and fragment NAMES and values, and userinfo, decoded — a placeholder
 * written into a path arrives encoded. The fragment is here because an OAuth implicit flow puts
 * the access token in it, and neither the query walk nor the path walk can see it. The names are
 * here for the same reason `findSurvivingSecrets` walks object keys: `?<jwt>=1` persists the token
 * exactly as well as `?token=<jwt>` does, and a gate that reads only values never sees it.
 */
function urlParts(parsed: URL): string[] {
  const fragment = fragmentParams(parsed.hash)
  const opaque = decodePart(parsed.hash.slice(1))
  return [
    ...parsed.pathname.split('/').filter(Boolean).map(decodePart),
    ...parsed.searchParams.keys(),
    ...parsed.searchParams.values(),
    ...(parsed.username ? [decodePart(parsed.username)] : []),
    ...(parsed.password ? [decodePart(parsed.password)] : []),
    ...(fragment ? [...fragment.keys(), ...fragment.values()] : opaque ? [opaque] : []),
  ]
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}
