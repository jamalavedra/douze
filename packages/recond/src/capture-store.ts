import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  AnnotationSpan,
  CaptureSession,
  Exchange,
  findSurvivingSecrets,
  redactBody,
  redactHeaders,
  redactUrl,
} from '@recon/shared'

/**
 * #CaptureStore — persists sessions, exchanges, and annotation spans, and is the last gate
 * before anything touches disk (AC-CAP-005, TR-6). Uses node:sqlite so recond ships with no
 * native dependency to compile.
 */
export class CaptureStore {
  private readonly db: DatabaseSync

  constructor(filename: string) {
    this.db = new DatabaseSync(filename)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, origins TEXT NOT NULL,
        started_at INTEGER NOT NULL, stopped_at INTEGER, debugger_enabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS exchanges (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL, doc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, note TEXT NOT NULL,
        start_position INTEGER NOT NULL, end_position INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS exchanges_session ON exchanges(session_id, position);
    `)
  }

  /**
   * The extension owns session identity — it allocates the id and stamps every exchange with it,
   * so the daemon must adopt that id rather than minting its own. HAR import has no upstream id
   * and gets a fresh one.
   */
  startSession(input: {
    id?: string
    name: string
    origins: string[]
    debugger_enabled?: boolean
  }): CaptureSession {
    // AC-CAP-001.2 — an unnamed session is rejected before anything is written.
    const session = CaptureSession.parse({
      id: input.id ?? randomUUID(),
      name: input.name,
      origins: input.origins,
      started_at: Date.now(),
      debugger_enabled: input.debugger_enabled ?? false,
    })
    this.db
      .prepare('INSERT OR REPLACE INTO sessions (id,name,origins,started_at,debugger_enabled) VALUES (?,?,?,?,?)')
      .run(session.id, session.name, JSON.stringify(session.origins), session.started_at, session.debugger_enabled ? 1 : 0)
    return session
  }

  stopSession(id: string): { retained: number } {
    this.db.prepare('UPDATE sessions SET stopped_at = ? WHERE id = ?').run(Date.now(), id)
    // AC-CAP-001.4 — the count reported is what survived filtering, not what was seen.
    return { retained: this.countExchanges(id) }
  }

  /**
   * Redaction is re-applied here even though the extension already ran it, because recond also
   * ingests HAR files and must not depend on an upstream having been careful (AC-CAP-006.1).
   */
  appendExchange(input: Exchange): Exchange {
    const exchange = Exchange.parse({
      ...input,
      url: redactUrl(input.url),
      request_headers: redactHeaders(input.request_headers ?? {}),
      response_headers: redactHeaders(input.response_headers ?? {}),
      request_body: redactBody(input.request_body),
      response_body: redactBody(input.response_body),
    })

    const leaked = findSurvivingSecrets({
      url: exchange.url,
      request_headers: exchange.request_headers,
      response_headers: exchange.response_headers,
      request_body: exchange.request_body,
      response_body: exchange.response_body,
    })
    if (leaked.length > 0) {
      throw new Error(`refusing to persist exchange ${exchange.id}: credential at ${leaked.join(', ')}`)
    }

    this.db
      .prepare('INSERT OR REPLACE INTO exchanges (id,session_id,position,doc) VALUES (?,?,?,?)')
      .run(exchange.id, exchange.session_id, exchange.position, JSON.stringify(exchange))
    return exchange
  }

  /**
   * AC-CAP-007.2 — a span covers everything captured since the previous note. When nothing has
   * been captured since, the span is EMPTY (end < start) rather than claiming the next exchange
   * that has not happened yet — that one arrives after the note, so the note cannot describe it.
   */
  annotate(sessionId: string, note: string): AnnotationSpan {
    const previous = this.db
      .prepare('SELECT MAX(end_position) AS last FROM annotations WHERE session_id = ?')
      .get(sessionId) as { last: number | null }
    const start = previous?.last === null || previous?.last === undefined ? 0 : previous.last + 1
    // Positions are assigned by the extension and may be sparse, so anchor on the real maximum.
    const highest = this.db
      .prepare('SELECT MAX(position) AS max FROM exchanges WHERE session_id = ?')
      .get(sessionId) as { max: number | null }
    const end = highest?.max === null || highest?.max === undefined ? start - 1 : highest.max

    const span = AnnotationSpan.parse({
      id: randomUUID(),
      session_id: sessionId,
      note,
      start_position: start,
      end_position: end,
    })
    this.db
      .prepare('INSERT INTO annotations (id,session_id,note,start_position,end_position) VALUES (?,?,?,?,?)')
      .run(span.id, span.session_id, span.note, span.start_position, span.end_position)
    return span
  }

  countExchanges(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ?').get(sessionId) as {
      n: number
    }
    return row.n
  }

  nextPosition(sessionId: string): number {
    return this.countExchanges(sessionId)
  }

  exchanges(sessionId: string): Exchange[] {
    const rows = this.db
      .prepare('SELECT doc FROM exchanges WHERE session_id = ? ORDER BY position')
      .all(sessionId) as { doc: string }[]
    return rows.map((row) => JSON.parse(row.doc) as Exchange)
  }

  annotations(sessionId: string): AnnotationSpan[] {
    return this.db
      .prepare('SELECT id,session_id,note,start_position,end_position FROM annotations WHERE session_id = ? ORDER BY start_position')
      .all(sessionId) as unknown as AnnotationSpan[]
  }

  sessions(): CaptureSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all() as Record<string, unknown>[]
    return rows.map((row) =>
      CaptureSession.parse({
        ...row,
        origins: JSON.parse(row['origins'] as string),
        debugger_enabled: Boolean(row['debugger_enabled']),
        stopped_at: row['stopped_at'] ?? undefined,
      }),
    )
  }

  session(id: string): CaptureSession | null {
    return this.sessions().find((s) => s.id === id) ?? null
  }

  close(): void {
    this.db.close()
  }
}
