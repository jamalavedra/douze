import { z } from 'zod'

/** REQ-CAP-003 — the element, route, and gesture immediately preceding an exchange. */
export const UiProvenance = z.object({
  /** Accessible name of the activated control, e.g. "Create order". */
  accessible_name: z.string(),
  role: z.string(),
  route: z.string(),
  title: z.string(),
})

/** AC-CAP-002.3 — how the exchange reached us, and whether its body is trustworthy. */
export const CaptureSource = z.enum(['main_world', 'web_request', 'har'])

/**
 * AC-EXE-001.3 — how the page supplies a credential: read `expression` in the page, prefix it, and
 * send it as `header`. Carries no secret, which is what lets it live in a committed recipe.
 */
export const CredentialHint = z.object({
  /** The header the value was sent in, when it was sent as one. */
  header: z.string().optional(),
  /** The path segment index it occupied, when it was part of the URL instead. */
  segment: z.number().int().nonnegative().optional(),
  expression: z.string(),
  prefix: z.string().default(''),
  /**
   * The header value itself, and ONLY when `expression` is empty because the page keeps it nowhere
   * readable — a token hardcoded in the site's own JavaScript. Kept because the alternative is a
   * tool that can never run; exempt from the write gate by path (see `APPROVED_LITERAL`).
   */
  value: z.string().optional(),
})

export const Exchange = z.object({
  id: z.string(),
  session_id: z.string(),
  /** Monotonic position within the session; Annotation Spans index into this. */
  position: z.number().int().nonnegative(),
  started_at: z.number(),
  duration_ms: z.number().nonnegative(),
  method: z.string(),
  url: z.url(),
  origin: z.string(),
  request_headers: z.record(z.string(), z.string()).default({}),
  request_body: z.unknown().optional(),
  status: z.number().int(),
  response_headers: z.record(z.string(), z.string()).default({}),
  response_body: z.unknown().optional(),
  response_content_type: z.string().optional(),
  response_size: z.number().int().nonnegative().optional(),
  /** AC-CAP-002.2/.3 — body absent because it was binary, oversized, or unobservable. */
  body_missing: z.boolean().default(false),
  body_missing_reason: z.enum(['too_large', 'not_utf8', 'interceptor_miss', 'har_no_content']).optional(),
  /** AC-CAP-003.3 — no user gesture preceded this request. */
  background: z.boolean().default(false),
  provenance: UiProvenance.optional(),
  source: CaptureSource,
  /**
   * AC-EXE-001.3 — the origin of the PAGE that issued this request, which is not the target when a
   * dashboard calls its API host. Execution needs it: the token lives in that origin's storage and
   * the site's CORS is configured for requests coming from it.
   */
  page_origin: z.string().optional(),
  /**
   * Where the page kept the credentials it sent, discovered in the page at capture time. Locations
   * only — a storage key and a header name, never a value.
   */
  credentials: z.array(CredentialHint).default([]),
})

/**
 * REQ-CAP-007 — a note covering every exchange captured since the previous note.
 *
 * The cap is a trust boundary, not tidiness. A note becomes sentence one of the tool description
 * verbatim, the attachment protocol caps a tool description at 4096 characters, and a host DROPS a
 * frame that fails to parse — so an unbounded note is an unbounded description is a surface that
 * silently never arrives and a client that sees no tools and no error. Refused here at the point of
 * entry, where the user is still looking at what they typed; the description path truncates as
 * well, because this is not the only way text reaches it.
 *
 * 500 characters is several sentences of intent, which is all a note is for.
 */
export const MAX_NOTE_CHARS = 500

export const AnnotationSpan = z.object({
  id: z.string(),
  session_id: z.string(),
  note: z.string().min(1).max(MAX_NOTE_CHARS),
  start_position: z.number().int().nonnegative(),
  /** `end < start` denotes an empty span — a note attached with nothing captured since the last. */
  end_position: z.number().int().min(-1),
})

export const CaptureSession = z.object({
  id: z.string(),
  /** AC-CAP-001.2 — a session must be named. */
  name: z.string().min(1),
  /** AC-CAP-001.1 — only exchanges from these origins are recorded. */
  origins: z.array(z.string()).min(1),
  started_at: z.number(),
  stopped_at: z.number().optional(),
})

export type Exchange = z.infer<typeof Exchange>
export type CaptureSession = z.infer<typeof CaptureSession>
export type AnnotationSpan = z.infer<typeof AnnotationSpan>
export type UiProvenance = z.infer<typeof UiProvenance>

/**
 * AC-CAP-004.1 — bundled noise list. Matched as a domain suffix so subdomains are covered.
 * Analytics, error reporting, session replay, ads, and telemetry.
 */
export const NOISE_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googlesyndication.com',
  'segment.com',
  'segment.io',
  'sentry.io',
  'bugsnag.com',
  'datadoghq.com',
  'newrelic.com',
  'nr-data.net',
  'fullstory.com',
  'logrocket.com',
  'hotjar.com',
  'mixpanel.com',
  'amplitude.com',
  'posthog.com',
  'intercom.io',
  'heap.io',
  'clarity.ms',
  'launchdarkly.com',
  'statsig.com',
  'pendo.io',
  'facebook.net',
  'cloudflareinsights.com',
]

/** AC-CAP-004.2 — only these response content types can carry an inferable payload. */
const ALLOWED_CONTENT = [
  'application/json',
  'application/graphql',
  'application/x-www-form-urlencoded',
  'text/plain',
  'text/json',
  '+json',
]

export interface NoiseConfig {
  hosts: string[]
}

export const defaultNoise = (): NoiseConfig => ({ hosts: [...NOISE_HOSTS] })

export function isNoiseHost(url: string, config: NoiseConfig = defaultNoise()): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return true
  }
  return config.hosts.some((noise) => host === noise || host.endsWith(`.${noise}`))
}

export function isInferableContentType(contentType: string | undefined): boolean {
  if (!contentType) return false
  const normalized = contentType.toLowerCase()
  return ALLOWED_CONTENT.some((allowed) => normalized.includes(allowed))
}

/**
 * AC-CAP-004 — the single filter both live capture and HAR import apply, so the two paths
 * cannot drift apart (AC-CAP-006.1).
 *
 * `origins` is the *target* filter, and it is null for live capture. A dashboard almost never
 * serves its own API: `dashboard.example.com` calls `api.example.com`, and requiring the target
 * to be the page's origin dropped every request that mattered — a recording of a real site
 * retained nothing at all. Live capture does not need this check, because it only ever sees
 * requests the recorded tab itself made: the interceptor is registered on the granted origin and
 * the oracle filters on the recording tab's id. The noise list and the content type are what
 * remain.
 *
 * A HAR is different — it is a recording of the whole browser, with no tab to attribute a
 * request to — so importing one still names the origins it may keep.
 */
export function shouldCapture(
  candidate: {
    url: string
    origin: string
    method?: string | undefined
    response_content_type?: string | undefined
  },
  origins: readonly string[] | null,
  noise: NoiseConfig = defaultNoise(),
): boolean {
  if (origins !== null && !origins.includes(candidate.origin)) return false
  if (isNoiseHost(candidate.url, noise)) return false
  if (isInferableContentType(candidate.response_content_type)) return true
  // A write answering `204 No Content` has no content type, and requiring one dropped most POSTs
  // and PUTs while leaving GETs untouched: for a write the method, path and request body ARE the
  // tool, and only the response schema is empty. An allowlist, not "anything but GET" — that also
  // admits the `OPTIONS` preflight of every cross-origin call.
  return candidate.response_content_type === undefined && /^(POST|PUT|PATCH|DELETE)$/i.test(candidate.method ?? '')
}
