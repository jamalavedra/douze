/**
 * REQ-CAP-005 — redaction runs in the extension's service worker before an exchange crosses
 * the loopback boundary, and again as a gate on every fixture write (AC-REC-004.2).
 * TR-6: no secret may reach a recipe, fixture, generated source, or log.
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
    out[name] = matches(name, config.headers) && !isPlaceholder(value) ? placeholder(value) : value
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
  for (const [key, value] of [...params.entries()]) {
    if (matches(key, config.fields) && !isPlaceholder(value)) {
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
  if (Array.isArray(body)) return body.map((item) => redactBody(item, config))
  if (body !== null && typeof body === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      out[key] =
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
  for (const [key, value] of [...parsed.searchParams.entries()]) {
    if (matches(key, config.fields) || looksLikeCredential(value)) {
      parsed.searchParams.set(key, placeholder(value))
      changed = true
    }
  }
  return changed ? parsed.toString() : url
}

/**
 * AC-REC-004.2 — the write gate. Detects credential-*shaped* values that survived key-based
 * redaction: JWTs, bearer prefixes, and long high-entropy tokens under innocuous key names.
 * Returns the JSON paths of anything suspicious; an empty array means the write may proceed.
 */
export function findSurvivingSecrets(value: unknown, path = '$'): string[] {
  if (isPlaceholder(value)) return []
  if (typeof value === 'string') return looksLikeCredential(value) ? [path] : []
  if (Array.isArray(value)) return value.flatMap((v, i) => findSurvivingSecrets(v, `${path}[${i}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => findSurvivingSecrets(v, `${path}.${k}`))
  }
  return []
}

const JWT = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/
const BEARER = /^(bearer|basic)\s+\S{8,}/i
/** Openfort and Stripe-style prefixed keys, plus generic `sk_`/`pk_` secrets. */
const PREFIXED_KEY = /\b(sk|pk|rk)_(test|live|prod)?_?[A-Za-z0-9]{16,}\b/

function looksLikeCredential(value: string): boolean {
  if (JWT.test(value) || BEARER.test(value) || PREFIXED_KEY.test(value)) return true
  // A long, unbroken, mixed-alphabet run with no spaces reads as a token rather than prose.
  if (value.length >= 40 && !/\s/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)) {
    return shannonEntropy(value) > 3.5
  }
  return false
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
