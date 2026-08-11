import { findSurvivingSecrets, redactBody, redactHeaders, redactUrl, type Exchange } from '@douze/shared'

/** REQ-REC-004 — a real, redacted exchange stored beside the recipe for load checks and drift. */
export interface Fixture {
  tool: string
  recorded_at: string
  request: { method: string; url: string; headers: Record<string, string>; body?: unknown }
  response: { status: number; headers: Record<string, string>; body?: unknown }
}

export function toFixture(tool: string, exchange: Exchange): Fixture {
  return {
    tool,
    recorded_at: new Date(exchange.started_at).toISOString(),
    request: {
      method: exchange.method,
      // Re-redacted like the headers and the bodies beside it, and for the same reason: the store
      // ran redaction on the way in, and a fixture is written out to disk by `exportRecipe`. An
      // exchange that reached here from anywhere else — a HAR import, an older store — carries
      // whatever its URL carried.
      url: redactUrl(exchange.url),
      headers: redactHeaders(exchange.request_headers),
      ...(exchange.request_body !== undefined ? { body: redactBody(exchange.request_body) } : {}),
    },
    response: {
      status: exchange.status,
      headers: redactHeaders(exchange.response_headers),
      ...(exchange.response_body !== undefined ? { body: redactBody(exchange.response_body) } : {}),
    },
  }
}

/** Where a fixture lives relative to the fixtures root, and what the recipe records. */
export const fixtureReference = (recipe: string, tool: string): string => `${recipe}/${tool}.json`

/**
 * AC-REC-004.1 / AC-REC-004.2 — the write gate. Redaction runs again here even though the capture
 * store already ran it, and a surviving credential-shaped value fails the write rather than
 * writing a file someone has to notice later (TR-6). Pure so every store — the filesystem or
 * extension storage — passes through the same gate.
 */
export function assertFixtureSafe(fixture: Fixture): void {
  const leaked = findSurvivingSecrets(fixture)
  if (leaked.length > 0) {
    throw new Error(
      `refusing to write fixture for "${fixture.tool}": credential-shaped value at ${leaked.join(', ')}`,
    )
  }
}
