import {
  type Exchange,
  type NoiseConfig,
  type RedactionConfig,
  type UiProvenance,
  defaultNoise,
  defaultRedaction,
  redactBody,
  redactHeaders,
  redactUrl,
  shouldCapture,
} from '@douze/shared'
import type { CapturedBody, GestureEvent } from './messages.js'

/** AC-CAP-003.1 — a gesture older than this did not cause the request. */
export const PROVENANCE_WINDOW_MS = 2000

/**
 * How long a `web_request` or `debugger` observation waits for the MAIN-world interceptor to
 * claim the same request before it is emitted on its own. Long enough to cover the bridge's
 * 250 ms batch plus a slow response body read.
 */
export const RECONCILE_GRACE_MS = 1500

type MissingReason = NonNullable<Exchange['body_missing_reason']>

export interface DecodedBody {
  value?: unknown
  missing?: MissingReason
  size?: number
}

const JSONISH = /json|graphql/i

/** AC-CAP-002.2 — a non-UTF-8 or oversized body yields its size and type, never the bytes. */
export function decodeBody(body: CapturedBody | null | undefined, contentType?: string): DecodedBody {
  if (!body) return {}
  if (body.binary !== undefined) return { missing: 'not_utf8', size: body.binary }
  if (body.truncated) return { missing: 'too_large', ...(body.text === undefined ? {} : { size: body.text.length }) }
  if (body.text === undefined) return {}
  if (contentType && JSONISH.test(contentType)) {
    try {
      return { value: JSON.parse(body.text) as unknown, size: body.text.length }
    } catch {
      return { value: body.text, size: body.text.length }
    }
  }
  return { value: body.text, size: body.text.length }
}

/**
 * AC-CAP-003.1 / .3 — attach the gesture that preceded the request inside the window, and
 * mark the exchange `background` rather than attaching a stale gesture when none did.
 */
export function attribute(
  startedAt: number,
  gesture: GestureEvent | undefined,
  windowMs = PROVENANCE_WINDOW_MS,
): { provenance: UiProvenance } | { background: true } {
  if (!gesture) return { background: true }
  const age = startedAt - gesture.t
  if (age < 0 || age > windowMs) return { background: true }
  return {
    provenance: {
      accessible_name: gesture.accessible_name,
      role: gesture.role,
      route: gesture.route,
      title: gesture.title,
    },
  }
}

/** Everything known about one observed request, before session context is applied. */
export interface ExchangeDraft {
  method: string
  url: string
  started_at: number
  duration_ms: number
  request_headers: Record<string, string>
  request_body?: unknown
  status: number
  response_headers: Record<string, string>
  response_body?: unknown
  response_content_type?: string
  response_size?: number
  body_missing: boolean
  body_missing_reason?: MissingReason
  source: Exchange['source']
  /** Where it was observed. Used only to look up that tab's last gesture; never persisted. */
  tab_id?: number
  /**
   * The gesture current when the *request* was issued. Captured then rather than looked up at
   * emit time, because an exchange is emitted on its response — by which point a later click
   * has already replaced the gesture that actually caused it.
   */
  gesture?: GestureEvent
}

export interface SessionContext {
  session_id: string
  position: number
  gesture?: GestureEvent | undefined
  redaction?: RedactionConfig
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * AC-CAP-004 — the shared filter decides inclusion, so live capture and HAR import cannot
 * drift apart. Returns null when the draft is noise, off-origin, or not an inferable type.
 */
export function admits(draft: ExchangeDraft, origins: string[], noise: NoiseConfig = defaultNoise()): boolean {
  return shouldCapture(
    { url: draft.url, origin: originOf(draft.url), response_content_type: draft.response_content_type },
    origins,
    noise,
  )
}

/**
 * REQ-CAP-005 — redaction runs here, in the service worker, before the exchange is handed to
 * the WebSocket client. No unredacted payload crosses the loopback boundary.
 */
export function finalize(draft: ExchangeDraft, ctx: SessionContext, id: string): Exchange {
  const redaction = ctx.redaction ?? defaultRedaction()
  const provenance = attribute(draft.started_at, ctx.gesture)
  return {
    id,
    session_id: ctx.session_id,
    position: ctx.position,
    started_at: draft.started_at,
    duration_ms: draft.duration_ms,
    method: draft.method,
    // A credential in a query string bypasses header and body redaction entirely.
    url: redactUrl(draft.url, redaction),
    origin: originOf(draft.url),
    request_headers: redactHeaders(draft.request_headers, redaction),
    ...(draft.request_body === undefined ? {} : { request_body: redactBody(draft.request_body, redaction) }),
    status: draft.status,
    response_headers: redactHeaders(draft.response_headers, redaction),
    ...(draft.response_body === undefined ? {} : { response_body: redactBody(draft.response_body, redaction) }),
    ...(draft.response_content_type === undefined ? {} : { response_content_type: draft.response_content_type }),
    ...(draft.response_size === undefined ? {} : { response_size: draft.response_size }),
    body_missing: draft.body_missing,
    ...(draft.body_missing_reason === undefined ? {} : { body_missing_reason: draft.body_missing_reason }),
    background: 'background' in provenance,
    ...('provenance' in provenance ? { provenance: provenance.provenance } : {}),
    source: draft.source,
  }
}

/** Observation jitter between two capture paths watching one request. */
const SAME_REQUEST_MS = 50

/**
 * T-002.6 — an exchange the interceptor and the debugger both saw is emitted exactly once.
 *
 * The paths share no request id, so a MAIN-world emission is matched to a deferred oracle or
 * debugger draft by (method, url) within the grace window, consuming one credit per match.
 *
 * Counting an ordinal per source and then keying the claim source-blind does NOT work, and the
 * failure is silent data loss rather than a duplicate: the oracle observes a SUPERSET of
 * MAIN-world traffic — service workers and sendBeacon are its whole reason to exist — so its
 * counter runs ahead. A service-worker GET (oracle ordinal 1) and a later page fetch of the same
 * URL (main-world ordinal 1) collide on one key, and the oracle-only exchange, which is exactly
 * the headers-only record AC-CAP-002.3 mandates, is dropped. Credits cannot collide that way:
 * one MAIN-world emission suppresses at most one deferred draft.
 */
export class Reconciler {
  /**
   * Unconsumed MAIN-world emissions per `method|url`, holding each one's `started_at`. Matching
   * on the REQUEST's own start time rather than on arrival is what separates "one request both
   * paths saw" from "two requests to the same URL": the former share a start instant, the latter
   * do not, however close together they arrive.
   */
  private readonly credits = new Map<string, number[]>()
  private deferred: Array<{ key: string; due: number; draft: ExchangeDraft }> = []

  private static key(draft: ExchangeDraft): string {
    return `${draft.method}|${draft.url}`
  }

  /**
   * The MAIN-world path emits immediately and banks a credit; the oracle and debugger paths
   * wait out the grace window so a body-bearing capture of the same request wins.
   */
  accept(draft: ExchangeDraft, now: number): ExchangeDraft[] {
    const key = Reconciler.key(draft)
    if (draft.source === 'main_world') {
      const credits = this.credits.get(key) ?? []
      credits.push(draft.started_at)
      this.credits.set(key, credits)
      return [draft]
    }
    this.deferred.push({ key, due: now + RECONCILE_GRACE_MS, draft })
    return []
  }

  /** Drafts whose grace window has elapsed and that no richer capture accounted for. */
  due(now: number): ExchangeDraft[] {
    const ready = this.deferred.filter((entry) => entry.due <= now)
    this.deferred = this.deferred.filter((entry) => entry.due > now)

    const out: ExchangeDraft[] = []
    for (const entry of ready) {
      const credits = this.credits.get(entry.key)
      // Same underlying request => same start instant, allowing for observation jitter between
      // the two paths. A genuinely separate call to the same URL starts at a different time.
      const index = credits?.findIndex((at) => Math.abs(at - entry.draft.started_at) <= SAME_REQUEST_MS) ?? -1
      if (credits && index >= 0) {
        credits.splice(index, 1)
        if (credits.length === 0) this.credits.delete(entry.key)
        continue
      }
      out.push(entry.draft)
    }

    for (const [key, times] of this.credits) {
      const fresh = times.filter((at) => now - at <= 5 * 60_000)
      if (fresh.length === 0) this.credits.delete(key)
      else this.credits.set(key, fresh)
    }
    return out
  }

  get pending(): number {
    return this.deferred.length
  }
}
