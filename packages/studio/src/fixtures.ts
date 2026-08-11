import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findSurvivingSecrets, redactBody, redactHeaders, type Exchange } from '@douze/shared'

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
      url: exchange.url,
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

/**
 * AC-REC-004.1 / AC-REC-004.2 — the write gate. Redaction runs again here even though the capture
 * store already ran it, and a surviving credential-shaped value fails the write rather than
 * writing a file someone has to notice later (TR-6).
 */
export function writeFixture(fixturesDir: string, recipe: string, fixture: Fixture): string {
  const leaked = findSurvivingSecrets(fixture)
  if (leaked.length > 0) {
    throw new Error(
      `refusing to write fixture for "${fixture.tool}": credential-shaped value at ${leaked.join(', ')}`,
    )
  }
  const relative = join(recipe, `${fixture.tool}.json`)
  const absolute = join(fixturesDir, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 })
  return relative
}

export function readFixtures(fixturesDir: string, recipe: string): Fixture[] {
  let entries: string[]
  try {
    entries = readdirSync(join(fixturesDir, recipe))
  } catch {
    return []
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(fixturesDir, recipe, name), 'utf8')) as Fixture)
}
