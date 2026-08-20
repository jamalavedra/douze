import type { ExchangeDraft } from './pipeline.js'

/**
 * T-001.5 / AC-CAP-002.3 — `chrome.webRequest` as a completeness oracle. It never sees a
 * response body (no MV3 API does), but it does see traffic the MAIN-world patch cannot:
 * the page's own service worker, web workers, `sendBeacon`. Anything it observed that the
 * interceptor did not becomes a headers-only exchange marked `body_missing`.
 *
 * Listeners must be registered synchronously at the top level of the service worker: a
 * listener added after an `await` silently stops working once the worker is respawned.
 */

interface Seen {
  method: string
  url: string
  startedAt: number
  requestHeaders: Record<string, string>
  requestBody?: unknown
}

const headersToRecord = (list: chrome.webRequest.HttpHeader[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const header of list ?? []) out[header.name.toLowerCase()] = header.value ?? ''
  return out
}

function decodeRequestBody(details: chrome.webRequest.OnBeforeRequestDetails): unknown {
  const body = details.requestBody
  if (!body) return undefined
  if (body.formData) return body.formData
  const raw = body.raw?.[0]?.bytes
  if (!raw) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(raw))) as unknown
  } catch {
    return undefined
  }
}

/** REQ-012/015 — `url` is what replay re-issues; `finalUrl` is where the server landed. */
export interface Navigation {
  tabId: number
  url: string
  finalUrl: string
  status: number
  responseHeaders: Record<string, string>
  startedAt: number
  durationMs: number
}

export interface OracleHandlers {
  /** Synchronous gate: globals die with the worker, so this reads cached session state. */
  isRecording: (tabId: number) => boolean
  onObserved: (draft: ExchangeDraft) => void
  /** A page the recorded tab loaded. No draft yet: its body is the document, read from the tab. */
  onNavigation: (navigation: Navigation) => void
}

/**
 * The traffic this oracle filters for. It was `['xmlhttprequest']` alone, which quietly excluded
 * the two things the docblock above says it exists to catch:
 *
 *   - `navigator.sendBeacon` is reported as `ping`, never `xmlhttprequest`.
 *   - A `<form method="post">` submit is a NAVIGATION — `main_frame` or `sub_frame` — so a
 *     server-rendered dashboard's every write was invisible to both capture paths at once.
 *
 * `other` joins them because Chrome files a few worker-initiated requests under it. The two
 * navigation types are filtered by method below rather than excluded here.
 */
export const WATCHED: `${chrome.webRequest.ResourceType}`[] = [
  'xmlhttprequest',
  'ping',
  'other',
  'main_frame',
  'sub_frame',
]
const NAVIGATION = new Set(['main_frame', 'sub_frame'])

/**
 * A navigation is worth *observing as an exchange* only when it changes something — a form POST.
 * A page load has no observable body here, so it takes the `onNavigation` path instead (REQ-012)
 * and is read from the loaded document; a sub-frame load is out of scope either way.
 */
export const worthWatching = (type: string, method: string): boolean =>
  !NAVIGATION.has(type) || method.toUpperCase() !== 'GET'

/** REQ-012 — the page the user is looking at, and the only navigation Douze reads. */
const isPageLoad = (type: string, method: string): boolean =>
  type === 'main_frame' && method.toUpperCase() === 'GET'

export function installOracle(handlers: OracleHandlers): void {
  if (!chrome.webRequest) return
  const inflight = new Map<string, Seen>()

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!handlers.isRecording(details.tabId)) return
      if (!worthWatching(details.type, details.method) && !isPageLoad(details.type, details.method)) return
      // A redirect fires this again for the next leg under the same request id. The first leg is
      // the request — the URL replay re-issues and the method the user's form used — and a 302
      // that turns a POST into a GET of the result page must not rewrite either (REQ-015).
      if (inflight.has(details.requestId)) return
      // A navigation POST is nearly always a form the user typed into, and most often a login.
      // Redaction is key-name matching, which cannot recognise a human password by its value, so
      // the body is dropped rather than filtered — no field-name list to keep ahead of `passwd`
      // or `mot_de_passe`. The method, URL and response still make the write visible to
      // inference; only its input schema is given up.
      const body = NAVIGATION.has(details.type) ? undefined : decodeRequestBody(details)
      inflight.set(details.requestId, {
        method: details.method,
        url: details.url,
        startedAt: details.timeStamp,
        requestHeaders: {},
        ...(body === undefined ? {} : { requestBody: body }),
      })
    },
    { urls: ['<all_urls>'], types: WATCHED },
    ['requestBody'],
  )

  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      const seen = inflight.get(details.requestId)
      if (seen) seen.requestHeaders = headersToRecord(details.requestHeaders)
    },
    { urls: ['<all_urls>'], types: WATCHED },
    ['requestHeaders'],
  )

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const seen = inflight.get(details.requestId)
      inflight.delete(details.requestId)
      if (!seen || !handlers.isRecording(details.tabId)) return
      const responseHeaders = headersToRecord(details.responseHeaders)
      const contentType = responseHeaders['content-type']
      if (isPageLoad(details.type, seen.method)) {
        handlers.onNavigation({
          tabId: details.tabId,
          // REQ-015 — what was asked for, and where it ended up: a search form commonly 302s to a
          // canonical result page, and replay has to re-issue the request, not its destination.
          url: seen.url,
          finalUrl: details.url,
          status: details.statusCode,
          responseHeaders,
          startedAt: seen.startedAt,
          durationMs: Math.max(0, details.timeStamp - seen.startedAt),
        })
        return
      }
      handlers.onObserved({
        method: seen.method,
        url: seen.url,
        started_at: seen.startedAt,
        duration_ms: Math.max(0, details.timeStamp - seen.startedAt),
        request_headers: seen.requestHeaders,
        ...(seen.requestBody === undefined ? {} : { request_body: seen.requestBody }),
        status: details.statusCode,
        response_headers: responseHeaders,
        ...(contentType === undefined ? {} : { response_content_type: contentType }),
        body_missing: true,
        body_missing_reason: 'interceptor_miss',
        source: 'web_request',
      })
    },
    { urls: ['<all_urls>'], types: WATCHED },
    ['responseHeaders'],
  )

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => inflight.delete(details.requestId),
    { urls: ['<all_urls>'], types: WATCHED },
  )
}
