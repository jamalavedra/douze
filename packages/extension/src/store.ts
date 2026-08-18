import {
  AnnotationSpan,
  CaptureSession,
  Exchange,
  findSurvivingSecrets,
  redactBody,
  redactHeaders,
  redactUrl,
} from '@douze/shared'

/**
 * #CaptureStore — sessions, exchanges and annotation spans in IndexedDB, inside the extension.
 * Replaces douzed's SQLite store (T-015.1), so a capture needs no daemon and never leaves the
 * browser. Ordering is (session_id, position), held by a compound index rather than an ORDER BY.
 *
 * Storage: the manifest must carry the `unlimitedStorage` permission. Without it Chrome caps the
 * extension's IndexedDB at the shared per-origin quota and evicts it under pressure — a long
 * recording of a chatty dashboard is tens of MB of response bodies, and losing half a session
 * silently is worse than failing to record it.
 */

export const DB_NAME = 'douze-capture'
/** Bump together with a matching `if (oldVersion < n)` branch in `upgrade`. */
const DB_VERSION = 1

const SESSIONS = 'sessions'
const EXCHANGES = 'exchanges'
const ANNOTATIONS = 'annotations'
/** (session_id, position) — the index IS the ordering guarantee. */
const BY_POSITION = 'by_position'
/** (session_id, end_position) — the last key gives MAX(end_position) without reading rows. */
const BY_END = 'by_end_position'

export interface SessionSummary extends CaptureSession {
  exchange_count: number
}

export interface SessionDetail {
  session: CaptureSession
  /** Ascending by position, as the compound index stores them. */
  exchanges: Exchange[]
  annotations: AnnotationSpan[]
}

const promisify = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = (): void => {
      resolve(request.result)
    }
    request.onerror = (): void => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })

/**
 * Every key of one session. The upper bound is `[id, []]` because an array sorts after every
 * other key type in IndexedDB, so this covers any position without naming a maximum.
 */
const sessionRange = (sessionId: string): IDBKeyRange => IDBKeyRange.bound([sessionId], [sessionId, []])

function upgrade(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore(SESSIONS, { keyPath: 'id' })
    const exchanges = db.createObjectStore(EXCHANGES, { keyPath: 'id' })
    exchanges.createIndex(BY_POSITION, ['session_id', 'position'])
    const annotations = db.createObjectStore(ANNOTATIONS, { keyPath: 'id' })
    annotations.createIndex(BY_END, ['session_id', 'end_position'])
  }
}

export class CaptureStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name: string = DB_NAME): Promise<CaptureStore> {
    const request = indexedDB.open(name, DB_VERSION)
    request.onupgradeneeded = (event): void => {
      upgrade(request.result, event.oldVersion)
    }
    return new CaptureStore(await promisify(request))
  }

  /**
   * The capture pipeline owns session identity — it allocates the id and stamps every exchange
   * with it — so an existing id is adopted rather than replaced. HAR import has no upstream id
   * and gets a fresh one.
   */
  async startSession(input: {
    id?: string
    name: string
    origins: string[]
  }): Promise<CaptureSession> {
    // AC-CAP-001.2 — an unnamed session is rejected before anything is written.
    const session = CaptureSession.parse({
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      origins: input.origins,
      started_at: Date.now(),
    })
    await this.put(SESSIONS, session)
    return session
  }

  async stopSession(id: string): Promise<{ retained: number }> {
    const session = await this.read<CaptureSession>(SESSIONS, id)
    if (session) await this.put(SESSIONS, { ...session, stopped_at: Date.now() })
    // AC-CAP-001.4 — the count reported is what survived filtering, not what was seen.
    return { retained: await this.countExchanges(id) }
  }

  /**
   * THE write path for exchanges (AC-CAP-005, TR-6). Redaction is re-applied here even though the
   * capture pipeline already ran it, and the whole document is then gated: anything
   * `findSurvivingSecrets` still recognises is refused rather than stored.
   *
   * The gate is here rather than upstream because HAR import (T-015.5) never passes through
   * capture-time redaction at all, and any future ingest will have the same hole. It is the only
   * method that writes an exchange record, `db` is private, and the module exports no object-store
   * access — so from outside this file there is no way to persist an exchange that skipped it.
   *
   * The FULL document is scanned, not url + headers + bodies: `credentials[]` holds locations
   * supplied by the pipeline (a storage key, a header name), and a hint carrying the value itself
   * used to reach disk unread — the whole record is what gets written, so the whole record is
   * what gets checked.
   */
  async appendExchange(input: Exchange): Promise<Exchange> {
    const exchange = Exchange.parse({
      ...input,
      url: redactUrl(input.url),
      request_headers: redactHeaders(input.request_headers ?? {}),
      response_headers: redactHeaders(input.response_headers ?? {}),
      request_body: redactBody(input.request_body),
      response_body: redactBody(input.response_body),
    })
    const leaked = findSurvivingSecrets(exchange)
    if (leaked.length > 0) {
      throw new Error(`refusing to persist exchange ${exchange.id}: credential at ${leaked.join(', ')}`)
    }
    await this.put(EXCHANGES, exchange)
    return exchange
  }

  /**
   * AC-CAP-007.2 — a span covers everything captured since the previous note. When nothing has
   * been captured since, the span is EMPTY (end < start) rather than claiming the next exchange
   * that has not happened yet — that one arrives after the note, so the note cannot describe it.
   */
  async annotate(sessionId: string, note: string): Promise<AnnotationSpan> {
    const previousEnd = await this.lastKeyPart(ANNOTATIONS, BY_END, sessionId)
    const start = previousEnd === null ? 0 : previousEnd + 1
    // Positions are assigned by the pipeline and may be sparse, so anchor on the real maximum.
    const highest = await this.lastKeyPart(EXCHANGES, BY_POSITION, sessionId)
    const span = AnnotationSpan.parse({
      id: crypto.randomUUID(),
      session_id: sessionId,
      note,
      start_position: start,
      end_position: highest === null ? start - 1 : highest,
    })
    await this.put(ANNOTATIONS, span)
    return span
  }

  async countExchanges(sessionId: string): Promise<number> {
    return (await this.sessionKeys(EXCHANGES, BY_POSITION, sessionId)).length
  }

  /** Newest first, each with the number of exchanges it retained. */
  async sessions(): Promise<SessionSummary[]> {
    const tx = this.db.transaction(SESSIONS, 'readonly')
    const rows = await promisify(tx.objectStore(SESSIONS).getAll())
    const summaries = await Promise.all(
      rows.map(async (row) => ({
        ...CaptureSession.parse(row),
        exchange_count: await this.countExchanges((row as CaptureSession).id),
      })),
    )
    return summaries.sort((a, b) => b.started_at - a.started_at)
  }

  async session(id: string): Promise<SessionDetail | null> {
    const row = await this.read<unknown>(SESSIONS, id)
    if (row === undefined) return null
    const tx = this.db.transaction([EXCHANGES, ANNOTATIONS], 'readonly')
    const exchanges = (await promisify(
      tx.objectStore(EXCHANGES).index(BY_POSITION).getAll(sessionRange(id)),
    )) as Exchange[]
    const annotations = (await promisify(
      tx.objectStore(ANNOTATIONS).index(BY_END).getAll(sessionRange(id)),
    )) as AnnotationSpan[]
    return {
      session: CaptureSession.parse(row),
      exchanges,
      annotations: annotations.sort((a, b) => a.start_position - b.start_position),
    }
  }

  /** The session and everything recorded under it. */
  async deleteSession(id: string): Promise<void> {
    const exchangeKeys = await this.sessionKeys(EXCHANGES, BY_POSITION, id)
    const annotationKeys = await this.sessionKeys(ANNOTATIONS, BY_END, id)
    const tx = this.db.transaction([SESSIONS, EXCHANGES, ANNOTATIONS], 'readwrite')
    await promisify(tx.objectStore(SESSIONS).delete(id))
    for (const key of exchangeKeys) await promisify(tx.objectStore(EXCHANGES).delete(key))
    for (const key of annotationKeys) await promisify(tx.objectStore(ANNOTATIONS).delete(key))
  }

  close(): void {
    this.db.close()
  }

  private async put(storeName: string, value: unknown): Promise<void> {
    const tx = this.db.transaction(storeName, 'readwrite')
    await promisify(tx.objectStore(storeName).put(value))
  }

  private async read<T>(storeName: string, key: string): Promise<T | undefined> {
    const tx = this.db.transaction(storeName, 'readonly')
    return (await promisify(tx.objectStore(storeName).get(key))) as T | undefined
  }

  /** Primary keys of one session's rows, in index order. */
  private async sessionKeys(storeName: string, indexName: string, sessionId: string): Promise<IDBValidKey[]> {
    const tx = this.db.transaction(storeName, 'readonly')
    return promisify(tx.objectStore(storeName).index(indexName).getAllKeys(sessionRange(sessionId)))
  }

  /** MAX(position) / MAX(end_position) for a session, or null when it has no rows. */
  private async lastKeyPart(storeName: string, indexName: string, sessionId: string): Promise<number | null> {
    const tx = this.db.transaction(storeName, 'readonly')
    const cursor = await promisify(
      tx.objectStore(storeName).index(indexName).openKeyCursor(sessionRange(sessionId), 'prev'),
    )
    return cursor === null ? null : (cursor.key as [string, number])[1]
  }
}
