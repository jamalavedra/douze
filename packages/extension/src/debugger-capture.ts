import { decodeBody, type ExchangeDraft } from './pipeline.js'

/**
 * T-002.5 / AC-CAP-002.4 — the ADR-002 fallback path, opt-in per session because attaching
 * shows a banner across every window in the profile. It is the only way to read response
 * bodies for traffic the page's own service worker issues.
 */

interface Pending {
  method: string
  url: string
  startedAt: number
  requestHeaders: Record<string, string>
  postData?: string
  sessionId?: string
}

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: 'service_worker' }, { type: 'worker' }, { type: 'iframe' }],
}

export class DebuggerCapture {
  private readonly pending = new Map<string, Pending>()
  private readonly attached = new Set<number>()
  private readonly listener = (
    source: chrome.debugger.DebuggerSession,
    method: string,
    params?: object,
  ): void => void this.onEvent(source, method, params)

  constructor(private readonly onObserved: (draft: ExchangeDraft) => void) {}

  get tabs(): number[] {
    return [...this.attached]
  }

  /**
   * Attaching mid-flight is the dominant cause of "No resource with given identifier found":
   * Chrome only retains bodies for requests it saw from `requestWillBeSent` onward, so the
   * tab is reloaded after `Network.enable`.
   */
  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return
    await chrome.debugger.attach({ tabId }, '1.3')
    this.attached.add(tabId)
    if (this.attached.size === 1) chrome.debugger.onEvent.addListener(this.listener)
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {})
    await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', AUTO_ATTACH)
    await chrome.tabs.reload(tabId)
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.delete(tabId)) return
    if (this.attached.size === 0) chrome.debugger.onEvent.removeListener(this.listener)
    await chrome.debugger.detach({ tabId }).catch(() => {})
  }

  async detachAll(): Promise<void> {
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot before mutating the collection being iterated
    for (const tabId of [...this.attached]) await this.detach(tabId)
    this.pending.clear()
  }

  /** Reloading an unpacked extension leaves the previous session attached. */
  static async clearZombies(): Promise<void> {
    if (!chrome.debugger) return
    const targets = await chrome.debugger.getTargets().catch(() => [])
    for (const target of targets) {
      if (target.attached && target.tabId !== undefined) {
        await chrome.debugger.detach({ tabId: target.tabId }).catch(() => {})
      }
    }
  }

  private async onEvent(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params?: object,
  ): Promise<void> {
    if (source.tabId === undefined || !this.attached.has(source.tabId)) return

    if (method === 'Target.attachedToTarget') {
      const child = { ...source, sessionId: (params as { sessionId: string }).sessionId }
      await chrome.debugger.sendCommand(child, 'Network.enable', {}).catch(() => {})
      await chrome.debugger.sendCommand(child, 'Target.setAutoAttach', AUTO_ATTACH).catch(() => {})
      // waitForDebuggerOnStart pauses the target; release it or the worker never runs.
      await chrome.debugger.sendCommand(child, 'Runtime.runIfWaitingForDebugger', {}).catch(() => {})
      return
    }

    if (method === 'Network.requestWillBeSent') {
      const p = params as {
        requestId: string
        request: { url: string; method: string; headers: Record<string, string>; postData?: string }
      }
      this.pending.set(p.requestId, {
        method: p.request.method,
        url: p.request.url,
        startedAt: Date.now(),
        requestHeaders: p.request.headers ?? {},
        ...(p.request.postData === undefined ? {} : { postData: p.request.postData }),
        ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
      })
      return
    }

    if (method === 'Network.responseReceived') {
      const p = params as { requestId: string; response: { headers: Record<string, string>; status: number } }
      this.responseHeaders.set(p.requestId, lowerKeys(p.response.headers ?? {}))
      this.statuses.set(p.requestId, p.response.status)
      return
    }

    // loadingFinished, not responseReceived: the body may still be incomplete at that point.
    if (method === 'Network.loadingFinished') {
      const p = params as { requestId: string }
      const seen = this.pending.get(p.requestId)
      if (!seen) return
      this.pending.delete(p.requestId)
      const responseHeaders = this.responseHeaders.get(p.requestId) ?? {}
      const status = this.statuses.get(p.requestId) ?? 0
      this.responseHeaders.delete(p.requestId)
      this.statuses.delete(p.requestId)
      const target = seen.sessionId
        ? { tabId: source.tabId, sessionId: seen.sessionId }
        : { tabId: source.tabId }
      let bodyText: string | undefined
      let base64 = false
      try {
        // Read eagerly: every millisecond raises the chance of buffer eviction.
        const res = (await chrome.debugger.sendCommand(target, 'Network.getResponseBody', {
          requestId: p.requestId,
        })) as { body: string; base64Encoded: boolean } | undefined
        bodyText = res?.body
        base64 = res?.base64Encoded ?? false
      } catch {
        // Expected for redirect hops, preflights, 204s, and evicted buffers: record the gap.
      }
      const contentType = responseHeaders['content-type']
      const decoded: ReturnType<typeof decodeBody> = base64
        ? { missing: 'not_utf8' }
        : bodyText === undefined
          ? { missing: 'interceptor_miss' }
          : decodeBody({ text: bodyText }, contentType)
      const requestHeaders = lowerKeys(seen.requestHeaders)
      const requestDecoded = decodeBody(
        seen.postData === undefined ? null : { text: seen.postData },
        requestHeaders['content-type'],
      )
      this.onObserved({
        method: seen.method,
        url: seen.url,
        started_at: seen.startedAt,
        duration_ms: Math.max(0, Date.now() - seen.startedAt),
        request_headers: requestHeaders,
        ...(requestDecoded.value === undefined ? {} : { request_body: requestDecoded.value }),
        status,
        response_headers: responseHeaders,
        ...(decoded.value === undefined ? {} : { response_body: decoded.value }),
        ...(contentType === undefined ? {} : { response_content_type: contentType }),
        ...(decoded.size === undefined ? {} : { response_size: decoded.size }),
        body_missing: decoded.missing !== undefined,
        ...(decoded.missing === undefined ? {} : { body_missing_reason: decoded.missing }),
        source: 'debugger',
      })
    }
  }

  private readonly responseHeaders = new Map<string, Record<string, string>>()
  private readonly statuses = new Map<string, number>()
}

const lowerKeys = (headers: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
  return out
}
