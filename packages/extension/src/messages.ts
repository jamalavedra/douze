/**
 * The wire shapes the MAIN-world interceptor and the ISOLATED bridge exchange with the
 * service worker. Type-only, so `interceptor.ts` and `bridge.ts` can import it and still
 * bundle to import-free classic scripts — which is why the studio import below is `import type`
 * and stays that way.
 */
import type { CandidateView, EditableField } from '@douze/studio/browser'

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
  /** Open the page that shares Douze with a hosted assistant. Opened by the worker, for the same reason. */
  | { type: 'douze:connect' }
  /** What is already set up on this site — the popup's quiet summary. */
  | { type: 'douze:site-tools'; origin: string }

export interface PopupStatus {
  session: { id: string; name: string; origins: string[] } | null
  count: number
  /** Origins the running session has actually recorded traffic to — execution's future targets. */
  seenOrigins: string[]
  noiseHosts: string[]
}

/** One approved tool on a site, as the popup lists it. */
export interface SiteTool {
  /** AC-RUN-001.2 — `<recipe>_<tool>`. */
  name: string
  description: string
  side_effect: 'read' | 'write' | 'destructive'
}

/** What `douze:site-tools` answers with. */
export interface SiteToolsResult {
  tools: SiteTool[]
}

/**
 * WO-015 T-015.4 — review page → service worker, replacing douzed's `/api/review/*` routes one
 * for one. The page holds no session state of its own beyond the tick boxes: every command names
 * the session, so a worker Chrome respawned mid-review still knows which capture is being read.
 */
export type ReviewCommand =
  | { type: 'douze:review:load'; sessionId: string }
  | { type: 'douze:review:edit'; sessionId: string; name: string; field: EditableField; value: string }
  | { type: 'douze:review:enable'; sessionId: string; names: string[] }
  | { type: 'douze:review:disable'; sessionId: string; names: string[] }
  | { type: 'douze:review:save'; sessionId: string }

/** What `douze:review:load` answers with — the shape douzed's `GET /api/review/:id` returned. */
export interface ReviewState {
  site: string
  recipe: string
  candidates: CandidateView[]
}

/** What `douze:review:save` answers with: the tools now on the surface. */
export interface ReviewSaved {
  tools: string[]
}

/**
 * Connect page → service worker. T-015.10 wires these to the real attachment; until then the
 * worker answers every action with `error` set and nothing changed.
 */
export type ConnectCommand =
  | { type: 'douze:connect:status' }
  | { type: 'douze:connect:start' }
  | { type: 'douze:connect:rotate' }
  | { type: 'douze:connect:stop' }

export interface ConnectState {
  /** Whether a link exists at all — the page shows setup or the link, never both. */
  configured: boolean
  /** The relay the link points at, named on the setup screen before anything is shared. */
  url: string
  /** The link itself. Empty until configured. */
  mcp_url: string
  allow_writes: boolean
  /** Whether the attachment is up right now. The link survives it being down. */
  connected: boolean
  /** Set when an action could not be carried out; the page shows it and changes nothing. */
  error?: string
}
