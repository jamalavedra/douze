import { isInferableContentType, isNoiseHost, shouldCapture, type Exchange } from '@douze/shared'
import type { CaptureStore } from './store.js'

/**
 * #HAR import (T-015.5) — REQ-CAP-006, ported from douzed's `har-import.ts` so a .har becomes a
 * Capture Session with no daemon. Filtering is the same `shouldCapture` live capture calls, and
 * redaction is not performed here at all: `CaptureStore.appendExchange` is the only write path and
 * it re-redacts and gates every record. HAR import is exactly the ingest that never passed through
 * capture-time redaction, which is why that gate lives in the store rather than in the pipeline.
 */

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

/** An entry the write gate refused, named well enough for the page to tell the user which. */
export interface RefusedEntry {
  url: string
  reason: string
}

export interface HarImportResult {
  session_id: string
  imported: number
  /** Filtered out: wrong origin, noise host, or a content type nothing can be inferred from. */
  skipped: number
  /** Passed the filter, then rejected by `appendExchange`. `imported + skipped + refused.length` = entries. */
  refused: RefusedEntry[]
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

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * The primary origin is whichever produced the most *inferable* requests. Counting raw entries
 * instead would hand the title to a CDN: a HAR with 100 images from cdn.app.com and 20 JSON calls
 * to app.com would pick the CDN and import nothing.
 */
function primaryOrigin(entries: HarEntry[]): string | undefined {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const origin = originOf(entry.request.url)
    if (origin === null) continue
    if (isNoiseHost(entry.request.url)) continue
    if (!isInferableContentType(entry.response.content?.mimeType)) continue
    counts.set(origin, (counts.get(origin) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function toExchange(entry: HarEntry, sessionId: string, origin: string, position: number): Exchange {
  // AC-CAP-006.2 — an entry without response content is marked, never discarded.
  const text = entry.response.content?.text
  const missing = text === undefined || text === '' || entry.response.content?.encoding === 'base64'
  const contentType = entry.response.content?.mimeType
  return {
    // A UUID (36 chars) and nothing prefixed onto it: at 40+ characters a random-looking id is
    // credential-shaped to `findSurvivingSecrets`, and the gate would refuse every exchange.
    id: crypto.randomUUID(),
    session_id: sessionId,
    position,
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
}

/**
 * AC-CAP-006.1 — same filtering as live capture, and every retained entry written through
 * `CaptureStore.appendExchange`, which applies redaction and the secret gate.
 *
 * A refused entry does NOT abort the import and is NOT dropped silently: it is collected in
 * `refused` and the rest of the file still imports. Aborting would throw away a 400-entry
 * recording over one bad row, and swallowing it would leave the user believing they imported
 * traffic they did not — the caller can report "N of M entries were not imported because they
 * still carried credentials" only if the refusals survive as data. Anything `appendExchange`
 * rejects lands here, gate or schema, because both mean the same thing to the user: not stored.
 *
 * `position` counts what was actually appended, so refusals leave no gap in the ordering.
 */
export async function importHar(har: unknown, name: string, captures: CaptureStore): Promise<HarImportResult> {
  const entries = ((har as { log?: { entries?: HarEntry[] } })?.log?.entries ?? []) as HarEntry[]
  if (entries.length === 0) throw new Error('HAR contains no entries')

  const primary = primaryOrigin(entries)
  if (primary === undefined) throw new Error('HAR contains no importable JSON exchanges')

  const session = await captures.startSession({ name, origins: [primary] })
  const refused: RefusedEntry[] = []
  let imported = 0
  let skipped = 0

  for (const entry of entries) {
    const origin = originOf(entry.request.url)
    const candidate = {
      url: entry.request.url,
      origin: origin ?? '',
      // Passed for the same reason live capture passes it: a bodiless write is kept, a bodiless
      // GET is not. Leaving it out here is what makes the two paths drift (AC-CAP-006.1).
      method: entry.request.method,
      response_content_type: entry.response.content?.mimeType,
    }
    if (origin === null || !shouldCapture(candidate, [primary])) {
      skipped += 1
      continue
    }
    try {
      await captures.appendExchange(toExchange(entry, session.id, origin, imported))
      imported += 1
    } catch (error) {
      refused.push({ url: entry.request.url, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  await captures.stopSession(session.id)
  return { session_id: session.id, imported, skipped, refused }
}
