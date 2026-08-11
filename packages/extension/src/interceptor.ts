/**
 * ADR-002 / REQ-CAP-002 — the primary capture path. Injected into the MAIN world at
 * `document_start` so it patches `fetch` and `XMLHttpRequest` before page scripts capture a
 * reference to them. Every wrapper falls through to the native implementation on any internal
 * throw: an interceptor that breaks the page is worse than no interceptor.
 *
 * Imports here must stay type-only — this file is injected as a classic content script.
 */
import type { CapturedBody, PageEvent } from './messages.js'

declare global {
  interface Window {
    __douze_interceptor__?: true
  }
}

;(() => {
  if (window.__douze_interceptor__) return
  Object.defineProperty(window, '__douze_interceptor__', { value: true })

  const MAX_BODY = 2 * 1024 * 1024
  const nativeFetch = window.fetch
  const NativeRequest = window.Request
  const NativeResponse = window.Response
  const NativeXHR = window.XMLHttpRequest

  let seq = 0
  const queue: PageEvent[] = []
  let bridgeReady = false

  /**
   * REQ-EXE-001 / AC-EXE-001.3 — where the page keeps the credential it just sent.
   *
   * A dashboard that authenticates with a bearer token records perfectly and then fails on its
   * first tool call: the recipe knows the header existed but not where its value comes from, and
   * redaction has (correctly) removed the value itself. This runs in the page, where the value is
   * still in hand, and reports the LOCATION only — a storage key, never the secret.
   *
   * Located once per distinct value: a dashboard sends the same token on every request, and
   * scanning storage per request would be paid hundreds of times for one answer.
   */
  const located = new Map<string, string | null>()

  function locate(value: string): string | null {
    if (value.length < 16) return null
    const cached = located.get(value)
    if (cached !== undefined) return cached
    const found = search(value)
    located.set(value, found)
    return found
  }

  function search(value: string): string | null {
    for (const [name, store] of [
      ['localStorage', window.localStorage],
      ['sessionStorage', window.sessionStorage],
    ] as const) {
      let keys: string[]
      try {
        keys = Object.keys(store)
      } catch {
        continue // storage can throw outright when the page is sandboxed or cookies are blocked
      }
      for (const key of keys) {
        let raw: string | null
        try {
          raw = store.getItem(key)
        } catch {
          continue
        }
        if (raw === null) continue
        if (raw === value) return `${name}.getItem(${JSON.stringify(key)})`
        // Supabase and most auth SDKs park the token inside a JSON blob under one key.
        const field = fieldHolding(raw, value)
        if (field) return `JSON.parse(${name}.getItem(${JSON.stringify(key)})).${field}`
      }
    }
    return null
  }

  /** The dotted path of a string field equal to `value`, one object deep plus one nesting. */
  function fieldHolding(raw: string, value: string): string | null {
    if (!raw.startsWith('{') && !raw.startsWith('[')) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (entry === value) return key
      if (entry !== null && typeof entry === 'object') {
        for (const [inner, deep] of Object.entries(entry as Record<string, unknown>)) {
          if (deep === value) return `${key}.${inner}`
        }
      }
    }
    return null
  }

  /**
   * The header carries a prefix as often as not (`Bearer ey…`), and the recipe stores the prefix
   * separately so the relay can rebuild the header around a freshly read value.
   */
  /**
   * A project key in the URL — `/v1/project/apikey/<key>/origins` — is a credential by shape, so
   * redaction replaces it and the recipe would carry a placeholder no server recognises. Located
   * here by segment index, so inference can turn that segment into a parameter the page fills.
   */
  function credentialsInPath(url: string): { segment: number; expression: string; prefix: string }[] {
    const found: { segment: number; expression: string; prefix: string }[] = []
    let parsed: URL
    try {
      parsed = new URL(url, window.location.href)
    } catch {
      return found
    }
    const segments = parsed.pathname.split('/')
    for (const [index, segment] of segments.entries()) {
      if (!segment) continue
      const expression = locate(decodeURIComponent(segment))
      if (expression) found.push({ segment: index, expression, prefix: '' })
    }
    return found
  }

  function credentialsIn(headers: Record<string, string>): { header: string; expression: string; prefix: string }[] {
    const found: { header: string; expression: string; prefix: string }[] = []
    for (const [header, value] of Object.entries(headers)) {
      if (typeof value !== 'string' || !value) continue
      const space = value.indexOf(' ')
      const candidates: [string, string][] =
        space > 0 && space < 12 ? [[value.slice(space + 1), value.slice(0, space + 1)], [value, '']] : [[value, '']]
      for (const [token, prefix] of candidates) {
        const expression = locate(token)
        if (expression) {
          found.push({ header, expression, prefix })
          break
        }
      }
    }
    return found
  }

  // Ordering between the MAIN and ISOLATED scripts at the same runAt is not guaranteed, so
  // buffer until the bridge announces itself rather than assuming it is already listening.
  function post(payload: PageEvent): void {
    if (!bridgeReady) {
      queue.push(payload)
      return
    }
    // '/' means "same origin as this document" and is the one form that works in about:blank
    // and sandboxed frames, where `location.origin` is the string "null".
    try {
      window.postMessage({ __douze: 1, dir: 'page->cs', payload }, '/')
    } catch {
      /* uncloneable payload — drop it rather than throwing into page code */
    }
  }

  window.addEventListener(
    'message',
    (e: MessageEvent) => {
      if (e.source !== window) return
      const data = e.data as { __douze?: number; dir?: string; kind?: string } | null
      if (data?.__douze !== 1 || data.dir !== 'cs->page' || data.kind !== 'ready') return
      bridgeReady = true
      for (const payload of queue.splice(0)) post(payload)
    },
    true,
  )

  function concat(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }

  async function drain(
    stream: ReadableStream<Uint8Array>,
    cap: number,
  ): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let truncated = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > cap) {
          truncated = true
          reader.cancel().catch(() => {})
          break
        }
        chunks.push(value)
      }
    } catch {
      truncated = true
    }
    return { bytes: concat(chunks), truncated }
  }

  const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|x-ndjson|graphql))/i

  function decode(bytes: Uint8Array, contentType: string | null): CapturedBody {
    if (contentType && !TEXTUAL.test(contentType)) return { binary: bytes.byteLength }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    } catch {
      return { binary: bytes.byteLength }
    }
  }

  const isStreaming = (res: Response): boolean =>
    /text\/event-stream|application\/(x-ndjson|stream\+json)/i.test(res.headers.get('content-type') ?? '') ||
    !res.headers.get('content-length')

  /**
   * Zero-buffer alternative to `clone()` for streaming responses: observes chunks at exactly
   * the rate the page reads them, so a slow SSE consumer cannot make Chrome buffer the whole
   * response in memory behind our tee branch.
   */
  function passthrough(res: Response, onDone: (r: { bytes: Uint8Array; truncated: boolean }) => void): Response {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let truncated = false
    const observed = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { done, value } = await reader.read()
        if (done) {
          ctrl.close()
          onDone({ bytes: concat(chunks), truncated })
          return
        }
        if (size + value.byteLength <= MAX_BODY) {
          chunks.push(value)
          size += value.byteLength
        } else {
          truncated = true
        }
        ctrl.enqueue(value)
      },
      cancel(reason) {
        onDone({ bytes: concat(chunks), truncated: true })
        return reader.cancel(reason)
      },
    })
    const out = new NativeResponse(observed, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
    // `new Response()` always reports url:'', redirected:false, type:'default' — restore them.
    for (const key of ['url', 'redirected', 'type'] as const) {
      Object.defineProperty(out, key, { value: res[key], enumerable: true })
    }
    return out
  }

  window.fetch = function douzeFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    let req: Request
    try {
      req = new NativeRequest(input, init)
    } catch {
      return nativeFetch.call(this as never, input, init)
    }

    const id = `f${++seq}`
    const meta = {
      id,
      kind: 'fetch' as const,
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers),
      t: Date.now(),
    }

    // A ReadableStream body cannot be cloned without stealing it from the caller.
    const rawBody = init && 'body' in init ? init.body : null
    const bodyPromise: Promise<CapturedBody | null> = (() => {
      if (!req.body) return Promise.resolve(null)
      if (rawBody instanceof ReadableStream) return Promise.resolve({ text: '<stream>' })
      try {
        return drain(req.clone().body as ReadableStream<Uint8Array>, MAX_BODY).then(({ bytes, truncated }) => ({
          ...decode(bytes, req.headers.get('content-type')),
          truncated,
        }))
      } catch {
        return Promise.resolve({ text: '<unreadable>' })
      }
    })()

    const credentials = [...credentialsIn(meta.headers), ...credentialsInPath(meta.url)]
    void bodyPromise.then((body) =>
      post({ type: 'request', ...meta, body, ...(credentials.length ? { credentials } : {}) }),
    )

    return nativeFetch.call(this as never, req).then(
      (res) => {
        const rmeta = {
          type: 'response' as const,
          id,
          status: res.status,
          url: res.url,
          headers: Object.fromEntries(res.headers),
          t: Date.now(),
        }
        // 204/304 and opaque responses have no readable body.
        if (!res.body || res.type === 'opaque' || res.type === 'opaqueredirect') {
          post({ ...rmeta, body: null })
          return res
        }
        if (isStreaming(res)) {
          return passthrough(res, ({ bytes, truncated }) =>
            post({ ...rmeta, body: { ...decode(bytes, res.headers.get('content-type')), truncated } }),
          )
        }
        // Drained in a detached promise: awaiting it would serialize the page behind the
        // recorder and change observable timing.
        drain(res.clone().body as ReadableStream<Uint8Array>, MAX_BODY)
          .then(({ bytes, truncated }) =>
            post({ ...rmeta, body: { ...decode(bytes, res.headers.get('content-type')), truncated } }),
          )
          .catch(() => post({ ...rmeta, body: null }))
        return res
      },
      (err: unknown) => {
        post({ type: 'error', id, message: String((err as Error)?.message ?? err), t: Date.now() })
        throw err
      },
    )
  }

  interface XhrState {
    id: string
    method: string
    url: string
    headers: Record<string, string>
    t: number
  }
  const STATE = Symbol('douze')
  type TrackedXhr = XMLHttpRequest & { [STATE]?: XhrState | null }

  const xOpen = NativeXHR.prototype.open
  const xSend = NativeXHR.prototype.send
  const xHeader = NativeXHR.prototype.setRequestHeader

  NativeXHR.prototype.open = function douzeOpen(
    this: TrackedXhr,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      this[STATE] = {
        id: `x${++seq}`,
        method,
        url: new URL(String(url), location.href).href,
        headers: {},
        t: Date.now(),
      }
    } catch {
      this[STATE] = null
    }
    return (xOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
  }

  NativeXHR.prototype.setRequestHeader = function douzeSetHeader(this: TrackedXhr, name: string, value: string) {
    const state = this[STATE]
    if (state) state.headers[name] = value
    return xHeader.call(this, name, value)
  }

  NativeXHR.prototype.send = function douzeSend(this: TrackedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    const state = this[STATE]
    if (state) {
      const credentials = [...credentialsIn(state.headers), ...credentialsInPath(state.url)]
      post({
        type: 'request',
        kind: 'xhr',
        id: state.id,
        url: state.url,
        method: state.method,
        headers: state.headers,
        ...(credentials.length ? { credentials } : {}),
        body: describeXhrBody(body),
        t: state.t,
      })
      this.addEventListener(
        'loadend',
        () => {
          post({
            type: 'response',
            id: state.id,
            status: this.status,
            url: this.responseURL,
            headers: parseRawHeaders(this.getAllResponseHeaders()),
            body: readXhrResponse(this),
            t: Date.now(),
          })
        },
        { once: true },
      )
    }
    return xSend.call(this, body ?? null)
  }

  function readXhrResponse(xhr: XMLHttpRequest): CapturedBody {
    try {
      switch (xhr.responseType) {
        case '':
        case 'text':
          return { text: String(xhr.responseText).slice(0, MAX_BODY) }
        case 'json':
          return { text: JSON.stringify(xhr.response).slice(0, MAX_BODY) }
        case 'document':
          return { text: new XMLSerializer().serializeToString(xhr.response as Node).slice(0, MAX_BODY) }
        default: {
          const r = xhr.response as { size?: number; byteLength?: number } | null
          return { binary: r?.size ?? r?.byteLength ?? 0 }
        }
      }
    } catch {
      return { binary: 0 }
    }
  }

  function describeXhrBody(body: Document | XMLHttpRequestBodyInit | null | undefined): CapturedBody | null {
    if (body == null) return null
    if (typeof body === 'string') return { text: body.slice(0, MAX_BODY) }
    if (body instanceof URLSearchParams) return { text: body.toString().slice(0, MAX_BODY) }
    if (body instanceof FormData) {
      const out: Record<string, string> = {}
      for (const [k, v] of body) out[k] = typeof v === 'string' ? v : `<file ${v.name} ${v.size}b>`
      return { text: JSON.stringify(out).slice(0, MAX_BODY) }
    }
    if (body instanceof Blob) return { binary: body.size }
    if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return { binary: body.byteLength }
    return { text: '<unknown>' }
  }

  function parseRawHeaders(raw: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of (raw || '').trim().split(/[\r\n]+/)) {
      const i = line.indexOf(':')
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
    }
    return out
  }
})()
