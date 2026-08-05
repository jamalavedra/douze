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

export interface OracleHandlers {
  /** Synchronous gate: globals die with the worker, so this reads cached session state. */
  isRecording: (tabId: number) => boolean
  onObserved: (draft: ExchangeDraft) => void
}

export function installOracle(handlers: OracleHandlers): void {
  if (!chrome.webRequest) return
  const inflight = new Map<string, Seen>()

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!handlers.isRecording(details.tabId)) return
      const body = decodeRequestBody(details)
      inflight.set(details.requestId, {
        method: details.method,
        url: details.url,
        startedAt: details.timeStamp,
        requestHeaders: {},
        ...(body === undefined ? {} : { requestBody: body }),
      })
    },
    { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
    ['requestBody'],
  )

  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      const seen = inflight.get(details.requestId)
      if (seen) seen.requestHeaders = headersToRecord(details.requestHeaders)
    },
    { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
    ['requestHeaders'],
  )

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const seen = inflight.get(details.requestId)
      inflight.delete(details.requestId)
      if (!seen || !handlers.isRecording(details.tabId)) return
      const responseHeaders = headersToRecord(details.responseHeaders)
      const contentType = responseHeaders['content-type']
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
    { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
    ['responseHeaders'],
  )

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => inflight.delete(details.requestId),
    { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
  )
}
