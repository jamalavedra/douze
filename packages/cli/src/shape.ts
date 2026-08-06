/**
 * REQ-RUN-004 — result shaping. A tool result is trimmed to the recipe's Primary Payload Path
 * and capped before it leaves the client, so a chat context is not spent on response envelopes.
 */

/** AC-RUN-004.2 — the cap on a trimmed result, measured as UTF-8 JSON bytes. */
export const MAX_RESULT_BYTES = 32 * 1024

export interface Shaped {
  data: unknown
  /** AC-RUN-004.2 — present only when the result was cut; the caller must be told. */
  truncated?: {
    message: string
    untrimmed_bytes: number
    returned_bytes: number
  }
  /** Set when the recipe's payload path did not resolve, so the full body was returned instead. */
  note?: string
}

export interface ShapeOptions {
  /** AC-INF-005.1 — JSONPath to the useful subtree. */
  primary_payload_path?: string | undefined
  /** AC-RUN-004.1 — `raw` skips the trim entirely. */
  raw?: boolean | undefined
}

export function shapeResult(body: unknown, options: ShapeOptions = {}): Shaped {
  const path = options.primary_payload_path
  let data = body
  let note: string | undefined

  if (!options.raw && path) {
    const picked = selectPath(body, path)
    if (picked === MISSING) {
      // Returning the envelope beats returning nothing: a stale path must not eat the response.
      note = `primary_payload_path "${path}" did not resolve; returning the full body.`
    } else {
      data = picked
    }
  }

  const encoded = Buffer.byteLength(json(data), 'utf8')
  if (encoded <= MAX_RESULT_BYTES) return note === undefined ? { data } : { data, note }

  const returned = cutToBytes(json(data), MAX_RESULT_BYTES)
  return {
    data: returned,
    truncated: {
      message: `Result truncated to ${MAX_RESULT_BYTES} bytes; the untrimmed result was ${encoded} bytes.`,
      untrimmed_bytes: encoded,
      returned_bytes: Buffer.byteLength(returned, 'utf8'),
    },
    ...(note === undefined ? {} : { note }),
  }
}

const json = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value) ?? 'null')

/** Distinguishes "the path selected `undefined`" from "the path does not exist". */
export const MISSING = Symbol('missing')

/**
 * The subset of JSONPath recipes actually record: a rooted dot/bracket path such as
 * `$.data.orders[0].id`. Filters and wildcards are deliberately unsupported — inference never
 * emits them, and a fuller evaluator would be code with no caller.
 */
export function selectPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of segments(path)) {
    if (current === null || current === undefined) return MISSING
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return MISSING
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return MISSING
    const record = current as Record<string, unknown>
    if (!(segment in record)) return MISSING
    current = record[segment]
  }
  return current
}

function segments(path: string): string[] {
  return path
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\['([^']*)'\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0)
}

/**
 * Cuts a string to at most `limit` BYTES without splitting a UTF-8 sequence.
 *
 * `Buffer.subarray(0, limit).toString('utf8')` looks right and is not: a split multi-byte
 * sequence decodes to a 3-byte U+FFFD, so an emoji straddling the boundary comes back one or two
 * bytes OVER the cap AC-RUN-004.2 exists to enforce — and mojibake with it. A continuation byte
 * is 0b10xxxxxx, so walking back to the last lead byte finds the real boundary.
 */
export function cutToBytes(value: string, limit: number): string {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= limit) return value

  let end = limit
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}
