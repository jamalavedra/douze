import type { CredentialSource, RelayRequest, RelayResponse } from '@douze/shared'

/**
 * ADR-004 / REQ-EXE-001 — execute through the browser instead of extracting credentials.
 *
 * The ladder, in order:
 *   1. a tab already on the EXECUTING origin → `executeScript` in the ISOLATED world. That origin
 *      is the recorded page, which is the target's own origin for a site that serves its own API
 *      and the dashboard for one that calls an API host. Either way it reproduces what the app
 *      does: correct Origin and Referer, the full cookie jar including HttpOnly and
 *      SameSite=Strict, indistinguishable from the page's own request.
 *   2. the recipe says the credential lives in page state → additionally read it from the MAIN
 *      world exactly as the app does (AC-EXE-001.3), then issue the request from ISOLATED so
 *      the replay cannot recurse through our own capture interceptor. This is why the executing
 *      origin matters: a token in the dashboard's storage is unreadable from the API's origin.
 *   3. no tab on that origin → open a background tab, run step 1 in it, close it
 *      (AC-EXE-001.4's offscreen tab).
 *
 * No offscreen document: `chrome.offscreen.createDocument` has no `reason` covering network
 * requests, and an extension-origin fetch buys nothing a content script does not already have.
 */

/** AC-EXE-002.1 — a redirect into one of these is an expired session, whatever the status. */
const LOGIN_PATH = /(^|\/)(login|signin|sign-in|sign_in|auth|authorize|sso|session(s)?\/new)(\/|$|\?)/i

export function isLoginRedirect(requestUrl: string, finalUrl: string | undefined): boolean {
  if (!finalUrl || finalUrl === requestUrl) return false
  try {
    return LOGIN_PATH.test(new URL(finalUrl).pathname)
  } catch {
    return false
  }
}

export function isExpired(status: number | undefined, loginRedirect: boolean): boolean {
  return loginRedirect || status === 401 || status === 403
}

/** The login page to point the user at when a session expires (AC-EXE-002.3). */
export const loginUrlFor = (origin: string, finalUrl?: string): string =>
  finalUrl && isLoginRedirect(origin, finalUrl) ? finalUrl : `${origin}/login`

/**
 * Injected into the MAIN world to read page-state credentials. Self-contained by necessity:
 * `chrome.scripting.executeScript` serializes this function, so it may not close over anything.
 *
 * Common accessor shapes are resolved structurally rather than through `eval`, because a page
 * with a strict CSP forbids `eval` in the MAIN world. `eval` remains the last resort.
 */
export function readPageCredentials(expressions: string[]): Array<string | null> {
  const scope = globalThis as unknown as Record<string, unknown>
  return expressions.map((expression) => {
    const source = expression.trim()
    const storage = /^(localStorage|sessionStorage)\s*\.\s*(?:getItem\(\s*['"`](.+?)['"`]\s*\)|([A-Za-z0-9_$]+))$/.exec(
      source,
    )
    if (storage) {
      try {
        const store = scope[storage[1] as string] as Storage | undefined
        return store?.getItem((storage[2] ?? storage[3]) as string) ?? null
      } catch {
        return null
      }
    }
    // `JSON.parse(localStorage.getItem("k")).a.b` — how every auth SDK worth naming stores a
    // token, and what capture-time discovery emits when it finds one nested. Modelled rather than
    // eval'd: this runs in the MAIN world, where a strict CSP refuses eval outright.
    const nested =
      /^JSON\.parse\(\s*(localStorage|sessionStorage)\s*\.\s*getItem\(\s*['"`](.+?)['"`]\s*\)\s*\)((?:\.[A-Za-z0-9_$]+)+)$/.exec(
        source,
      )
    if (nested) {
      try {
        const store = scope[nested[1] as string] as Storage | undefined
        const raw = store?.getItem(nested[2] as string)
        if (raw === null || raw === undefined) return null
        let cursor: unknown = JSON.parse(raw)
        for (const part of (nested[3] as string).slice(1).split('.')) {
          if (cursor === null || typeof cursor !== 'object') return null
          cursor = (cursor as Record<string, unknown>)[part]
        }
        return cursor === null || cursor === undefined ? null : String(cursor)
      } catch {
        return null
      }
    }
    if (source === 'document.cookie') {
      try {
        return (scope['document'] as Document | undefined)?.cookie ?? null
      } catch {
        return null
      }
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(source)) {
      let cursor: unknown = scope
      for (const part of source.split('.')) {
        if (part === 'window' || part === 'globalThis' || part === 'self') {
          cursor = scope
          continue
        }
        if (cursor === null || cursor === undefined) return null
        cursor = (cursor as Record<string, unknown>)[part]
      }
      return cursor === null || cursor === undefined ? null : String(cursor)
    }
    try {
      // eslint-disable-next-line no-eval -- last resort for accessor shapes we do not model.
      const value: unknown = (0, eval)(source)
      return value === null || value === undefined ? null : String(value)
    } catch {
      return null
    }
  })
}

export interface InjectedResult {
  status: number
  headers: Record<string, string>
  body: string
  url: string
  redirected: boolean
  error?: string
}

/**
 * Injected into the ISOLATED world of a tab on the target origin. Self-contained: it may not
 * close over anything in this module.
 */
export async function issueRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
  credentials: RequestCredentials = 'include',
): Promise<InjectedResult> {
  try {
    const res = await fetch(url, {
      method,
      headers,
      credentials,
      redirect: 'follow',
      // A hung target must not hold the relay open to the MV3 five-minute per-call ceiling.
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === null ? {} : { body }),
    })
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: await res.text(),
      url: res.url,
      redirected: res.redirected,
    }
  } catch (error) {
    return {
      status: 0,
      headers: {},
      body: '',
      url,
      redirected: false,
      error: String((error as Error)?.message ?? error),
    }
  }
}

/**
 * What a `page_state` credential source contributes (AC-EXE-001.3): headers, and the values of any
 * Endpoint Template parameters it fills — a project key in the URL is read from the page exactly
 * like one in a header, because an agent has no way to know it and a placeholder is not a URL.
 */
export function credentialContributions(
  sources: CredentialSource[],
  values: Array<string | null>,
): { headers: Record<string, string>; params: Record<string, string> } {
  const headers: Record<string, string> = {}
  const params: Record<string, string> = {}
  let index = 0
  for (const source of sources) {
    if (source.kind !== 'page_state') continue
    const value = values[index++]
    if (!value) continue
    const resolved = `${source.prefix}${value}`
    if (source.header) headers[source.header] = resolved
    if (source.param) params[source.param] = resolved
  }
  return { headers, params }
}

/** Kept as the header-only view, which is all most callers want. */
export const credentialHeaders = (
  sources: CredentialSource[],
  values: Array<string | null>,
): Record<string, string> => credentialContributions(sources, values).headers

export const pageStateSources = (sources: CredentialSource[]): Extract<CredentialSource, { kind: 'page_state' }>[] =>
  sources.filter((s): s is Extract<CredentialSource, { kind: 'page_state' }> => s.kind === 'page_state')

const parseBody = (text: string, contentType: string | undefined): unknown => {
  if (!text) return undefined
  if (contentType && /json|graphql/i.test(contentType)) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  return text
}

/**
 * The Executor Tab must not be the tab currently being recorded. A relayed request issued there
 * is observed by the webRequest oracle and ingested as a captured exchange, so Douze would infer
 * candidates from its own replays — and a `doctor` run mid-recording would poison the very
 * session it is meant to validate. Any other tab on the origin will do; if there is none, the
 * caller opens a dedicated one.
 */
async function findTab(origin: string, excludeTabId?: number): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({})
  return tabs.find((tab) => {
    if (!tab.url || tab.id === undefined) return false
    if (excludeTabId !== undefined && tab.id === excludeTabId) return false
    try {
      return new URL(tab.url).origin === origin
    } catch {
      return false
    }
  })
}

async function openExecutorTab(origin: string): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.create({ url: origin, active: false })
  await new Promise<void>((resolve) => {
    const done = (tabId: number, info: chrome.tabs.OnUpdatedInfo): void => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(done)
    // Never hang the relay on a tab that refuses to finish loading.
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(done)
      resolve()
    }, 15_000)
  })
  return tab
}

export interface RelayDeps {
  /** AC-EXE-002.3 — surface an expired session with a link to the target's login page. */
  notifyExpired: (origin: string, loginUrl: string) => void
  /** The tab being recorded, if any. Never used as an Executor Tab — see findTab. */
  recordingTabId?: number | undefined
}

/** REQ-EXE-001 — runs one relayed request and shapes the protocol response. */
export async function executeRelay(request: RelayRequest, deps: RelayDeps): Promise<RelayResponse> {
  const startedAt = Date.now()
  const fail = (error: string): RelayResponse => ({
    id: request.id,
    ok: false,
    headers: {},
    duration_ms: Date.now() - startedAt,
    error,
    redirected_to_login: false,
  })

  /**
   * AC-EXE-001.3 — the call runs from the PAGE, not from the API it talks to.
   *
   * A dashboard's token lives in its own origin's storage and its API accepts requests carrying
   * its own Origin header; replaying from a tab on the API host reads no token, sends a different
   * Origin, and comes back 401 — which Douze then reports as "you have been signed out", from a
   * browser that is perfectly signed in. `execute_origin` is the recorded page; without one the
   * target's own origin is right, which is the case for a site that serves its own API.
   */
  const executeOrigin = request.execute_origin ?? request.origin

  /**
   * `include` is right for a site that serves its own API — the cookie jar is the credential. It
   * is wrong, and fatal, for a cross-origin call to an API that answers `Access-Control-Allow-
   * Origin: *`: CORS forbids the wildcard on a credentialed request, so the browser rejects the
   * response and the fetch fails with nothing but "Failed to fetch". A token-authenticated app
   * does not send cookies cross-origin either, so omitting them is also the faithful replay.
   */
  const wantsCookies = request.credential_source.some((source) => source.kind === 'cookie')
  const credentialsMode: RequestCredentials =
    executeOrigin === request.origin || wantsCookies ? 'include' : 'omit'

  // Recorded is not the same as granted: a site's API lives on a host of its own, and Chrome
  // gives an extension nothing on an origin the user never allowed. Checked here so the reason
  // reaches the chat window as a sentence, rather than as "Cannot access contents of the page".
  for (const origin of new Set([executeOrigin, request.origin])) {
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
      return fail(
        `Douze has no permission for ${origin}, so it cannot run this there. ` +
          `Click the Douze button in Chrome, record the site again, and allow the permission it asks for.`,
      )
    }
  }

  let tab = await findTab(executeOrigin, deps.recordingTabId)
  let ephemeral = false
  if (!tab) {
    try {
      tab = await openExecutorTab(executeOrigin)
      ephemeral = true
    } catch (error) {
      return fail(`could not open an executor tab on ${executeOrigin}: ${String(error)}`)
    }
  }
  const tabId = tab.id
  if (tabId === undefined) return fail(`no executor tab available for ${executeOrigin}`)

  try {
    const headers = { ...request.headers }
    let url = request.url
    const pageState = pageStateSources(request.credential_source)
    if (pageState.length) {
      const [read] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [pageState.map((s) => s.expression)],
        func: readPageCredentials,
      })
      const contributed = credentialContributions(pageState, (read?.result as Array<string | null>) ?? [])
      Object.assign(headers, contributed.headers)
      // `{param}` left in the URL by the daemon, because only the page knows the value. Both
      // spellings: `new URL()` percent-encodes the braces on the way here, so matching only the
      // literal form left the placeholder in place and the call 404'd on `%7Bproject_key%7D`.
      for (const [param, value] of Object.entries(contributed.params)) {
        url = url.replaceAll(`{${param}}`, encodeURIComponent(value))
        url = url.replaceAll(`%7B${param}%7D`, encodeURIComponent(value))
        url = url.replaceAll(`%7b${param}%7d`, encodeURIComponent(value))
      }
    }

    const body =
      request.body === undefined || request.body === null
        ? null
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body)

    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [url, request.method, headers, body, request.timeout_ms, credentialsMode],
      func: issueRequest,
    })
    const result = injected?.result as InjectedResult | undefined
    if (!result) return fail('executor tab returned no result')
    if (result.error) return fail(result.error)

    const loginRedirect = isLoginRedirect(url, result.url)
    // Notified whatever kind of tab ran it. An agent calling a tool the user is not sitting in
    // front of opens an ephemeral tab every time — which is the common case, and was the one case
    // that stayed silent, so a signed-out session looked like a broken tool instead.
    if (isExpired(result.status, loginRedirect)) {
      deps.notifyExpired(request.origin, loginUrlFor(request.origin, result.url))
    }

    const responseBody = parseBody(result.body, result.headers['content-type'])
    return {
      id: request.id,
      ok: result.status >= 200 && result.status < 400 && !loginRedirect,
      status: result.status,
      headers: result.headers,
      ...(responseBody === undefined ? {} : { body: responseBody }),
      duration_ms: Date.now() - startedAt,
      redirected_to_login: loginRedirect,
    }
  } catch (error) {
    return fail(String((error as Error)?.message ?? error))
  } finally {
    if (ephemeral && tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {})
  }
}
