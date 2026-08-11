/**
 * The wire shapes the MAIN-world interceptor and the ISOLATED bridge exchange with the
 * service worker. Type-only, so `interceptor.ts` and `bridge.ts` can import it and still
 * bundle to import-free classic scripts.
 */

export interface CapturedBody {
  /** Decoded text, present when the payload was textual. */
  text?: string
  /** Byte length, present instead of `text` when the payload was not UTF-8 text. */
  binary?: number
  /** The body exceeded the interceptor's cap and was cut short. */
  truncated?: boolean
}

/** AC-EXE-001.3 — where the page keeps a credential, discovered in the page, value never included. */
export interface CredentialHint {
  /** Sent as a header… */
  header?: string
  /** …or occupying this path segment index. */
  segment?: number
  expression: string
  prefix: string
}

export interface RequestEvent {
  type: 'request'
  id: string
  kind: 'fetch' | 'xhr'
  url: string
  method: string
  headers: Record<string, string>
  body: CapturedBody | null
  t: number
  /** Present only when a header's value was found in the page's own storage. */
  credentials?: CredentialHint[]
}

export interface ResponseEvent {
  type: 'response'
  id: string
  status: number
  url: string
  headers: Record<string, string>
  body: CapturedBody | null
  t: number
}

export interface FailureEvent {
  type: 'error'
  id: string
  message: string
  t: number
}

/** REQ-CAP-003 — the last interactive element the user activated, and where they were. */
export interface GestureEvent {
  type: 'gesture'
  accessible_name: string
  role: string
  route: string
  title: string
  t: number
}

export type PageEvent = RequestEvent | ResponseEvent | FailureEvent | GestureEvent

export interface CaptureBatch {
  type: 'douze:capture'
  batch: PageEvent[]
}

/** Popup → service worker. */
export type PopupCommand =
  | { type: 'douze:start'; name: string; origins: string[]; tabId?: number; useDebugger: boolean }
  | { type: 'douze:stop' }
  | { type: 'douze:annotate'; note: string }
  | { type: 'douze:status' }
  /** AC-CAP-004.3 — additions to the bundled noise list, applied to subsequent sessions. */
  | { type: 'douze:noise'; hosts: string[] }
  /**
   * Open the review page for a finished session. The popup cannot do this itself: asking for a
   * permission closes it, and a closed popup runs no continuation.
   */
  | { type: 'douze:review'; sessionId: string }

export interface PopupStatus {
  session: { id: string; name: string; origins: string[] } | null
  count: number
  /** Origins the running session has actually recorded traffic to — the relay's future targets. */
  seenOrigins: string[]
  connected: boolean
  port: number
  token: string
  noiseHosts: string[]
}
