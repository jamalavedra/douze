import {
  type Exchange,
  type NoiseConfig,
  type RedactionConfig,
  type UiProvenance,
  defaultNoise,
  defaultRedaction,
  redactBody,
  redactHeaders,
  shouldCapture,
} from '@recon/shared'
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
    url: draft.url,
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

/**
 * T-002.6 — an exchange the interceptor and the debugger both saw is emitted exactly once.
 * The two paths share no request id, so they are correlated on (method, url, ordinal) with a
 * per-source counter, the same correlation the webRequest oracle uses.
 *
 * ponytail: ordinals drift if one path misses a request to a URL another path saw twice; the
 * consequence is one duplicate, not a lost exchange. Correlate on timing too if it bites.
 */
export class Reconciler {
  private readonly ordinals = new Map<string, number>()
  private readonly claimed = new Map<string, number>()
  private deferred: Array<{ key: string; due: number; draft: ExchangeDraft }> = []

  private nextKey(draft: ExchangeDraft): string {
    const counterKey = `${draft.source}|${draft.method}|${draft.url}`
    const ordinal = (this.ordinals.get(counterKey) ?? 0) + 1
    this.ordinals.set(counterKey, ordinal)
    return `${draft.method}|${draft.url}|${ordinal}`
  }

  /**
   * The MAIN-world path emits immediately and claims the key; the oracle and debugger paths
   * wait out the grace window so a body-bearing capture of the same request wins.
   */
  accept(draft: ExchangeDraft, now: number): ExchangeDraft[] {
    const key = this.nextKey(draft)
    if (draft.source === 'main_world') {
      this.claimed.set(key, now)
      return [draft]
    }
    this.deferred.push({ key, due: now + RECONCILE_GRACE_MS, draft })
    return []
  }

  /** Drafts whose grace window has elapsed and that no richer capture claimed. */
  due(now: number): ExchangeDraft[] {
    const ready = this.deferred.filter((entry) => entry.due <= now)
    this.deferred = this.deferred.filter((entry) => entry.due > now)
    const out: ExchangeDraft[] = []
    for (const entry of ready) {
      if (this.claimed.has(entry.key)) continue
      this.claimed.set(entry.key, now)
      out.push(entry.draft)
    }
    for (const [key, at] of this.claimed) {
      if (now - at > 5 * 60_000) this.claimed.delete(key)
    }
    return out
  }

  get pending(): number {
    return this.deferred.length
  }
}
