import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import type { WebSocket } from 'ws'
import {
  HEARTBEAT_MS,
  ReconError,
  redactBody,
  findSurvivingSecrets,
  type RelayRequest,
  type RelayResponse,
  type ServerMessage,
  type SurfaceToolLike,
} from './types.js'
import type { SurfaceTool } from './registry.js'

/**
 * #RelayBridge — holds the extension WebSocket, correlates requests to responses, and enforces
 * every call guard *before* forwarding. Guards live here rather than in client code so they
 * cannot be bypassed by calling recond directly or from an ejected package.
 */
export class RelayBridge {
  private socket: WebSocket | null = null
  private heartbeat?: NodeJS.Timeout
  private readonly pending = new Map<
    string,
    { resolve: (r: RelayResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  /** AC-EXE-003.1 — per-tool call timestamps driving the rate limiter. */
  private readonly calls = new Map<string, number[]>()
  /** Serialises queued calls per tool so excess is delayed rather than dropped. */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly auditPath: string) {}

  attach(socket: WebSocket): void {
    this.socket?.close()
    this.socket = socket
    clearInterval(this.heartbeat)
    // ADR-003 — a send inside the 30s window keeps the MV3 service worker alive.
    this.heartbeat = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_MS)
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      clearInterval(this.heartbeat)
      // Fail every in-flight call immediately. Waiting out a 120s timeout for a failure we
      // already know about is the opposite of AC-CON-004's legibility requirement.
      this.failPending(
        new ReconError(
          'extension_disconnected',
          'The Recon Chrome extension disconnected while this call was in flight. Open Chrome and confirm the Recon extension is enabled, then retry.',
        ),
      )
    })
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === 1
  }

  /** Called by the WS layer when the extension answers a relay.request. */
  settle(response: RelayResponse): void {
    const entry = this.pending.get(response.id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(response.id)
    entry.resolve(response)
  }

  private failPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(error)
    }
  }

  private send(message: ServerMessage): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message))
  }

  /**
   * The single entry point for a tool call. Runs guards, queues under the rate limit, relays,
   * classifies the outcome, and writes an audit entry — in that order.
   */
  async call(
    surface: SurfaceTool,
    args: Record<string, unknown>,
    options: { timeout_ms?: number } = {},
  ): Promise<RelayResponse> {
    const started = Date.now()
    const label = surface.qualified_name
    try {
      this.guard(surface, args)
      const response = await this.enqueue(surface, () => this.dispatch(surface, args, options))
      this.classify(surface, response)
      this.audit(label, args, response.status ?? 0, Date.now() - started)
      return response
    } catch (error) {
      this.audit(label, args, -1, Date.now() - started, (error as Error).message)
      throw error
    }
  }

  /** Guards that must fire before any network request is issued (AC-EXE-003.2 and .4). */
  private guard(surface: SurfaceTool, args: Record<string, unknown>): void {
    if (surface.degraded) {
      throw new ReconError(
        'tool_degraded',
        `Tool "${surface.qualified_name}" is degraded and will not run: ${surface.degraded_reason ?? 'contract no longer matches the target'}. Run \`recon doctor ${surface.recipe}\` to review the proposed fix.`,
        { tool: surface.qualified_name, change: surface.degraded_reason },
      )
    }
    if (surface.tool.side_effect === 'destructive' && args['confirm'] !== true) {
      throw new ReconError(
        'confirm_required',
        `Tool "${surface.qualified_name}" performs a destructive action. Re-run it with confirm=true to proceed.`,
        { tool: surface.qualified_name },
      )
    }
    if (!this.connected) {
      throw new ReconError(
        'extension_disconnected',
        `The Recon Chrome extension is not connected, so "${surface.qualified_name}" cannot run against ${surface.base_url}. Open Chrome and confirm the Recon extension is enabled.`,
        { tool: surface.qualified_name, target: surface.base_url },
      )
    }
  }

  /**
   * AC-EXE-003.1 — excess calls queue rather than drop. Each tool has its own chain, so a
   * throttled tool never blocks another.
   */
  private enqueue<T>(surface: SurfaceTool, run: () => Promise<T>): Promise<T> {
    const limit = surface.tool.rate_limit_per_minute
    if (!limit) return run()

    const key = surface.qualified_name
    const chained = (this.queues.get(key) ?? Promise.resolve()).then(async () => {
      const now = Date.now()
      const recent = (this.calls.get(key) ?? []).filter((t) => now - t < 60_000)
      if (recent.length >= limit) {
        const wait = 60_000 - (now - recent[0]!)
        await new Promise((r) => setTimeout(r, wait))
      }
      this.calls.set(key, [...(this.calls.get(key) ?? []).filter((t) => Date.now() - t < 60_000), Date.now()])
      return run()
    })
    this.queues.set(
      key,
      chained.catch(() => undefined),
    )
    return chained
  }

  /** AC-EXE-001.2 — forward to the extension and wait for the correlated response. */
  private dispatch(
    surface: SurfaceTool,
    args: Record<string, unknown>,
    options: { timeout_ms?: number },
  ): Promise<RelayResponse> {
    // Re-check here, not only in guard(): a call queued behind a rate limit may have waited
    // minutes, and send() would otherwise no-op into a dead socket until the timeout fires.
    if (!this.connected) {
      return Promise.reject(
        new ReconError(
          'extension_disconnected',
          `The Recon Chrome extension is not connected, so "${surface.qualified_name}" cannot run against ${surface.base_url}. Open Chrome and confirm the Recon extension is enabled.`,
          { tool: surface.qualified_name, target: surface.base_url },
        ),
      )
    }

    const request = buildRequest(surface, args, options.timeout_ms)
    return new Promise<RelayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        reject(
          new ReconError(
            'timeout',
            `Tool "${surface.qualified_name}" did not return within ${request.timeout_ms}ms.`,
            { tool: surface.qualified_name, elapsed_ms: request.timeout_ms },
          ),
        )
      }, request.timeout_ms)
      this.pending.set(request.id, { resolve, reject, timer })
      this.send({ type: 'relay.request', request })
    })
  }

  /** AC-EXE-002.1 — 401, 403, or a login redirect all mean the same thing to the user. */
  private classify(surface: SurfaceTool, response: RelayResponse): void {
    const expired = response.status === 401 || response.status === 403 || response.redirected_to_login
    if (!expired) return
    throw new ReconError(
      'session_expired',
      `Your session for ${surface.base_url} has expired. Sign in again in Chrome, then retry.`,
      { tool: surface.qualified_name, target: surface.base_url },
    )
  }

  /**
   * AC-EXE-003.3 — every invocation leaves a redacted trace. TR-6 names logs explicitly, so the
   * same shape gate applied to fixtures runs here: an agent that pastes a key into a free-text
   * argument must not have it land in the audit log under a harmless name.
   */
  private audit(tool: string, args: Record<string, unknown>, status: number, duration: number, error?: string): void {
    const params = redactBody(args)
    const leaked = findSurvivingSecrets(params)
    const safe = leaked.length === 0 ? params : { redacted: `${leaked.length} credential-shaped argument(s) withheld` }
    const entry = { at: new Date().toISOString(), tool, params: safe, status, duration_ms: duration, error }
    try {
      appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`)
    } catch {
      // An unwritable audit log must not take down a tool call; the daemon reports it at start.
    }
  }
}

/**
 * Turns validated tool arguments into a concrete request: path params are substituted into the
 * Endpoint Template, the rest become a query string or a JSON body depending on the method.
 */
export function buildRequest(
  surface: SurfaceToolLike,
  args: Record<string, unknown>,
  timeout_ms = 120_000,
): RelayRequest {
  const { method, path, headers, graphql } = surface.tool.request
  const remaining = { ...args }
  delete remaining['confirm']
  delete remaining['raw']

  const resolvedPath = path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = remaining[name]
    delete remaining[name]
    return encodeURIComponent(String(value ?? ''))
  })

  const url = new URL(resolvedPath, surface.base_url)
  let body: unknown

  if (graphql) {
    // AC-INF-004.2 — the stored document is replayed with the caller's variables.
    body = { operationName: graphql.operation, query: graphql.document, variables: remaining }
  } else if (method === 'GET' || method === 'HEAD') {
    for (const [key, value] of Object.entries(remaining)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
  } else {
    body = remaining
  }

  return {
    id: randomUUID(),
    origin: new URL(surface.base_url).origin,
    url: url.toString(),
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body }),
    credential_source: surface.credential_source ?? [],
    timeout_ms,
  }
}
