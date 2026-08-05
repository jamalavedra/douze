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

export interface RequestEvent {
  type: 'request'
  id: string
  kind: 'fetch' | 'xhr'
  url: string
  method: string
  headers: Record<string, string>
  body: CapturedBody | null
  t: number
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
  type: 'recon:capture'
  frameUrl: string
  batch: PageEvent[]
}

/** Popup → service worker. */
export type PopupCommand =
  | { type: 'recon:start'; name: string; origins: string[]; tabId?: number; useDebugger: boolean }
  | { type: 'recon:stop' }
  | { type: 'recon:annotate'; note: string }
  | { type: 'recon:status' }
  /** AC-CAP-004.3 — additions to the bundled noise list, applied to subsequent sessions. */
  | { type: 'recon:noise'; hosts: string[] }

export interface PopupStatus {
  session: { id: string; name: string; origins: string[] } | null
  count: number
  connected: boolean
  port: number
  token: string
  noiseHosts: string[]
}
