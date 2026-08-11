import { randomUUID } from 'node:crypto'
import { isInferableContentType, isNoiseHost, shouldCapture, type Exchange } from '@douze/shared'
import type { CaptureStore } from './capture-store.js'

/** The slice of the HAR 1.2 spec we actually read. */
interface HarEntry {
  startedDateTime?: string
  time?: number
  request: {
    method: string
    url: string
    headers?: { name: string; value: string }[]
    postData?: { text?: string; mimeType?: string }
  }
  response: {
    status: number
    headers?: { name: string; value: string }[]
    content?: { text?: string; mimeType?: string; size?: number; encoding?: string }
  }
}

const headerMap = (headers: { name: string; value: string }[] = []): Record<string, string> =>
  Object.fromEntries(headers.map((h) => [h.name.toLowerCase(), h.value]))

const parseMaybeJson = (text: string | undefined): unknown => {
  if (text === undefined || text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * REQ-CAP-006 — a HAR becomes a Capture Session under exactly the same filtering and redaction
 * as live capture, so the two paths cannot produce different recipes from the same traffic.
 * Redaction itself is applied by CaptureStore.appendExchange (AC-CAP-006.1).
 */
export function importHar(
  store: CaptureStore,
  har: unknown,
  name: string,
): { session_id: string; imported: number; skipped: number } {
  const entries = ((har as { log?: { entries?: HarEntry[] } })?.log?.entries ?? []) as HarEntry[]
  if (entries.length === 0) throw new Error('HAR contains no entries')

  /**
   * The primary origin is whichever produced the most *inferable* requests. Counting raw entries
   * instead would hand the title to a CDN: a HAR with 100 images from cdn.app.com and 20 JSON
   * calls to app.com would pick the CDN and import nothing.
   */
  const counts = new Map<string, number>()
  for (const entry of entries) {
    let origin: string
    try {
      origin = new URL(entry.request.url).origin
    } catch {
      continue
    }
    if (isNoiseHost(entry.request.url)) continue
    if (!isInferableContentType(entry.response.content?.mimeType)) continue
    counts.set(origin, (counts.get(origin) ?? 0) + 1)
  }
  const primary = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!primary) throw new Error('HAR contains no importable JSON exchanges')

  const session = store.startSession({ name, origins: [primary] })
  let imported = 0
  let skipped = 0

  for (const entry of entries) {
    let origin: string
    try {
      origin = new URL(entry.request.url).origin
    } catch {
      skipped += 1
      continue
    }

    // AC-CAP-006.1 — the SAME filter live capture uses, called rather than re-implemented, so
    // the two paths cannot drift apart.
    const contentType = entry.response.content?.mimeType
    if (!shouldCapture({ url: entry.request.url, origin, response_content_type: contentType }, [primary])) {
      skipped += 1
      continue
    }

    // AC-CAP-006.2 — an entry without response content is marked, never discarded.
    const text = entry.response.content?.text
    const missing = text === undefined || text === '' || entry.response.content?.encoding === 'base64'

    const exchange: Exchange = {
      id: randomUUID(),
      session_id: session.id,
      position: store.nextPosition(session.id),
      started_at: Date.parse(entry.startedDateTime ?? '') || Date.now(),
      duration_ms: entry.time ?? 0,
      method: entry.request.method,
      url: entry.request.url,
      origin,
      request_headers: headerMap(entry.request.headers),
      request_body: parseMaybeJson(entry.request.postData?.text),
      status: entry.response.status,
      response_headers: headerMap(entry.response.headers),
      response_body: missing ? undefined : parseMaybeJson(text),
      response_content_type: contentType ?? 'application/json',
      response_size: entry.response.content?.size ?? 0,
      body_missing: missing,
      ...(missing ? { body_missing_reason: 'har_no_content' as const } : {}),
      background: false,
      source: 'har',
      credentials: [],
    }

    store.appendExchange(exchange)
    imported += 1
  }

  store.stopSession(session.id)
  return { session_id: session.id, imported, skipped }
}
