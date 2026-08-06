/**
 * The daemon's HTTP side: pairing (so the user never sees a port or a token) and the read-only
 * lookup the popup uses to say what Claude can already do on a site. Imports nothing, so the
 * popup bundle stays free of the shared schema package.
 *
 * `/pair` needs no token but only answers a `chrome-extension://` origin, echoing it back in
 * `Access-Control-Allow-Origin` — which is why these plain `fetch` calls work without any
 * host permission.
 */

export interface Pairing {
  port: number
  token: string
}

export interface SiteTool {
  name: string
  description: string
  side_effect: 'read' | 'write' | 'destructive'
}

/**
 * Pairing is not a one-time setup step: the token changes whenever Claude Desktop restarts the
 * daemon, so we re-pair whenever we have no token or the socket is down.
 */
export const needsPairing = (state: { token: string; connected: boolean }): boolean =>
  !state.token || !state.connected

const json = async (url: string, fetchFn: typeof fetch): Promise<unknown> => {
  const response = await fetchFn(url)
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

/** Returns null when the daemon is not running — the popup says so and nothing else happens. */
export async function pair(port: number, fetchFn: typeof fetch = fetch): Promise<Pairing | null> {
  try {
    const body = (await json(`http://127.0.0.1:${port}/pair`, fetchFn)) as Partial<Pairing>
    if (typeof body.token !== 'string' || !body.token) return null
    return { token: body.token, port: typeof body.port === 'number' ? body.port : port }
  } catch {
    return null
  }
}

/**
 * The ports the daemon tries, in the order it tries them, before giving up and taking an ephemeral
 * one. Duplicated rather than imported: this module stays free of `@douze/shared` so the popup
 * bundle does not pull in the recipe schema.
 */
export const PORT_RANGE = [8787, 8788, 8789, 8790, 8791]

/**
 * The stored port first, then the rest of the ladder — anything else already on 8787 (RStudio
 * Server binds it by default) pushes the daemon along it, and probing is the only way the extension
 * finds out. Without this the popup says it can't reach Claude Desktop forever while the daemon is
 * perfectly healthy one port over.
 *
 * A stored port outside the ladder is a deliberate pin — an e2e run on an ephemeral port — and is
 * never widened to a scan, which would let that run wander onto the developer's real daemon.
 *
 * Sequential and short-circuiting: this runs on the reconnect alarm, and the ordinary case answers
 * on the first request.
 */
export async function pairAny(port: number, fetchFn: typeof fetch = fetch): Promise<Pairing | null> {
  const rest = PORT_RANGE.includes(port) ? PORT_RANGE.filter((other) => other !== port) : []
  for (const candidate of [port, ...rest]) {
    const paired = await pair(candidate, fetchFn)
    if (paired) return paired
  }
  return null
}

export async function siteTools(
  { port, token }: Pairing,
  origin: string,
  fetchFn: typeof fetch = fetch,
): Promise<SiteTool[]> {
  const query = `origin=${encodeURIComponent(origin)}&token=${encodeURIComponent(token)}`
  try {
    const body = (await json(`http://127.0.0.1:${port}/api/site-tools?${query}`, fetchFn)) as {
      tools?: SiteTool[]
    }
    return Array.isArray(body.tools) ? body.tools : []
  } catch {
    return []
  }
}

export const reviewUrl = ({ port, token }: Pairing, sessionId: string): string =>
  `http://127.0.0.1:${port}/review/${sessionId}?token=${encodeURIComponent(token)}`
