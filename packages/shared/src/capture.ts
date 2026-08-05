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
export const CaptureSource = z.enum(['main_world', 'web_request', 'debugger', 'har'])

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
})

/** REQ-CAP-007 — a note covering every exchange captured since the previous note. */
export const AnnotationSpan = z.object({
  id: z.string(),
  session_id: z.string(),
  note: z.string().min(1),
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
  /** AC-CAP-002.4 — chrome.debugger capture was enabled for this session. */
  debugger_enabled: z.boolean().default(false),
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
 */
export function shouldCapture(
  candidate: { url: string; origin: string; response_content_type?: string | undefined },
  origins: string[],
  noise: NoiseConfig = defaultNoise(),
): boolean {
  if (!origins.includes(candidate.origin)) return false
  if (isNoiseHost(candidate.url, noise)) return false
  return isInferableContentType(candidate.response_content_type)
}
