/**
 * The wire shapes the MAIN-world interceptor and the ISOLATED bridge exchange with the
 * service worker. Type-only, so `interceptor.ts` and `bridge.ts` can import it and still
 * bundle to import-free classic scripts — which is why the studio import below is `import type`
 * and stays that way.
 */
import type { CandidateView, EditableField } from '@douze/studio/browser'
import type { AuditEntry } from './guards.js'
import type { HarImportResult } from './har.js'
import type { ExportedFile, ImportResult } from './recipes.js'
import type { SessionSummary } from './store.js'

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
  /**
   * The header value itself, and only when `expression` is empty because the page keeps it nowhere
   * readable. The worker parks it in session memory and strips it before anything is stored — see
   * `parkLiteral` in background.ts. It never reaches an Exchange.
   */
  value?: string
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
   *
   * `recipe:<name>` names a stored recipe instead of a capture — an imported recipe lands with
   * nothing approved and goes through this same page (`RECIPE_REVIEW_PREFIX`, background.ts).
   */
  | { type: 'douze:review'; sessionId: string }
  /** Open the page that shares Douze with a hosted assistant. Opened by the worker, for the same reason. */
  | { type: 'douze:connect' }
  /** Open the page listing what Douze has stored on this computer. Same reason again. */
  | { type: 'douze:data' }
  /** What is already set up on this site — the popup's quiet summary. */
  | { type: 'douze:site-tools'; origin: string }
  /**
   * AC-EXE-003.3 — the recent tool calls, most recent first. `douze status` printed these; the
   * daemon's audit file is gone, so the same surface is read out of extension storage instead.
   */
  | { type: 'douze:audit'; limit?: number }

/** What `douze:audit` answers with. */
export interface AuditResult {
  calls: AuditEntry[]
}

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
  /**
   * The decision on a header the page keeps nowhere readable: keep a copy for this origin and
   * resend it, or forget it. Asked per origin because that is the granularity of the trust.
   */
  | { type: 'douze:review:credential'; sessionId: string; origin: string; header: string; allow: boolean }

/** What `douze:review:load` answers with — the shape douzed's `GET /api/review/:id` returned. */
export interface ReviewState {
  site: string
  recipe: string
  candidates: CandidateView[]
  /**
   * Credential headers this capture used that Douze cannot re-read from the page, waiting for a
   * decision. The value is shown, because a person cannot consent to keeping something they have
   * not seen. Empty for every ordinary site.
   */
  pending_credentials: { origin: string; header: string; value: string }[]
}

/** What `douze:review:save` answers with: the tools now on the surface. */
export interface ReviewSaved {
  tools: string[]
}

/**
 * Data page → service worker: what Douze has stored on this computer, and the three doors in and
 * out of it. Each of these was a CLI subcommand (`douze import`, `douze export`, and the daemon's
 * own session delete) and had no replacement at all in the extension; the store methods behind
 * them existed and could not be reached.
 *
 * Same convention as the connect page: every command answers with the whole `DataState`, with the
 * report of what it just did alongside, so the page never infers what changed.
 */
export type DataCommand =
  | { type: 'douze:data:list' }
  /** REQ-CAP-006 — a .har becomes a Capture Session. `har` is the parsed file. */
  | { type: 'douze:data:import-har'; name: string; har: unknown }
  /** The recording and every exchange, annotation and byte under it. There is no undo. */
  | { type: 'douze:data:delete'; sessionId: string }
  /** The recipe and every example answer stored under it. The tools it carried stop existing. */
  | { type: 'douze:data:delete-recipe'; name: string }
  /** AC-EXE-003.3 — the record of what assistants have run. Nothing could remove it before. */
  | { type: 'douze:data:clear-audit' }
  | { type: 'douze:data:export' }
  /**
   * AC-REC-003 — `overwrite` is the answer to a `conflicts` the page just showed the reader by
   * name. Absent means refuse the whole set again rather than take anything.
   */
  | { type: 'douze:data:import'; files: ExportedFile[]; overwrite?: boolean }

/** What every `douze:data:*` command answers with. */
export interface DataState {
  /** Newest first, each with what it retained — the count the badge showed while recording. */
  sessions: SessionSummary[]
  recipes: { name: string; tools: number }[]
  /** The audit log, most recent first — stored on this computer, so it is listed on this page. */
  calls: AuditEntry[]
  /**
   * `douze:data:import-har` only. Carried whole, `refused` included: an import that quietly
   * reported a total would be claiming traffic the write gate did not store.
   */
  har?: HarImportResult
  /** `douze:data:export` only — the files, for the page to hand to a download. */
  files?: ExportedFile[]
  /** `douze:data:import` only, conflicts and errors included. */
  imported?: ImportResult
  /** Set when the action could not be carried out; nothing changed. */
  error?: string
}

/**
 * Connect page → service worker. Every one of these answers with the whole `ConnectState`, so the
 * page never has to infer what changed; a command that could not be carried out answers with
 * `error` set and nothing changed at all.
 */
export type ConnectCommand =
  | { type: 'douze:connect:status' }
  /**
   * T-015.10 — register with a relay and store the pairing. `url` is the relay to use; omitted
   * means the default one, which is what the page offers unless the user typed their own.
   */
  | { type: 'douze:connect:start'; url?: string }
  | { type: 'douze:connect:rotate' }
  | { type: 'douze:connect:stop' }
  /**
   * T-015.9/10 — the write opt-in, which is a property of the relay pairing. Destructive tools are
   * not reachable either way and no value here changes that.
   */
  | { type: 'douze:connect:writes'; allow: boolean }
  /**
   * T-015.12 — the code a local bridge printed to its stderr, typed in by the user. Loopback alone
   * is not consent: this is what earns a bridge `local` trust and its destructive tools with it.
   */
  | { type: 'douze:connect:pair'; code: string }
  /**
   * Withdraws that consent. The pairing was one-way until now: an app paired once kept `local`
   * trust — writes and destructive tools included — for the life of the install.
   */
  | { type: 'douze:connect:unpair' }
  /**
   * T-015.9 — exempt one tool's results from the secret gate, or put them back under it. Per trust
   * level: exempting a tool so an app on this computer can read a token must not also start
   * sending that token to a relay operator.
   */
  | { type: 'douze:connect:expose'; trust: 'local' | 'remote'; tool: string; allow: boolean }

/** What the connect page knows about the local bridge, which is a pairing and not a link. */
export type BridgeState = 'unpaired' | 'trying' | 'paired' | 'refused'

export interface ConnectState {
  /** Whether a link exists at all — the page shows setup or the link, never both. */
  configured: boolean
  /**
   * The relay the link points at. Before anything is shared this is the default the page offers,
   * which is the relay a user who types nothing will get.
   */
  url: string
  /** The link itself. Empty until configured. */
  mcp_url: string
  allow_writes: boolean
  /**
   * Whether Douze has a live attachment right now — to the relay, to a local bridge, or both. It
   * is deliberately not per-pipe: the attachment client reports one answer for all of them, and a
   * page that split it here would be inventing a distinction it cannot see.
   */
  connected: boolean
  /** Every approved tool's qualified name, so the expose control lists real tools and not a box. */
  tools: string[]
  /**
   * Tools exempt from the result secret gate, per trust level and never merged: exempting a tool
   * for an app on this computer must not start sending that value to a relay operator.
   */
  exposed: { local: string[]; remote: string[] }
  bridge: BridgeState
  /**
   * The relay has forgotten this link — it answered 1008 for the stored token, which is what a
   * relay says about every endpoint it held before it restarted. Distinct from `connected: false`,
   * which is a link that is merely idle and will come back on its own. This one never will, so the
   * page has to stop reassuring and say what fixes it.
   */
  stale: boolean
  /** Set when an action could not be carried out; the page shows it and changes nothing. */
  error?: string
  /** Set when the action WAS carried out but something about it did not work — see `stop`. */
  warning?: string
}
