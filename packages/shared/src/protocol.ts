import { z } from 'zod'
import { Exchange, AnnotationSpan, CaptureSession } from './capture.js'
import { CredentialSource } from './recipe.js'

/**
 * ADR-003 — the JSON protocol the extension speaks to douzed over `ws://127.0.0.1:<port>`.
 * Two families: `exchange.*` flows extension → daemon (capture), `relay.*` flows
 * daemon → extension and back (execution).
 */

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), token: z.string(), extension_version: z.string() }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('exchange.append'), exchange: Exchange }),
  z.object({ type: z.literal('exchange.session.start'), session: CaptureSession }),
  z.object({ type: z.literal('exchange.session.stop'), session_id: z.string(), retained: z.number() }),
  z.object({ type: z.literal('exchange.annotate'), span: AnnotationSpan }),
  z.object({ type: z.literal('relay.response'), id: z.string(), response: z.lazy(() => RelayResponse) }),
])

/** A single relayed request, issued by the extension from an Executor Tab. */
export const RelayRequest = z.object({
  id: z.string(),
  origin: z.string(),
  url: z.url(),
  method: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  /** AC-EXE-001.3 — read these from page state exactly as the app does. */
  credential_source: z.array(CredentialSource).default([]),
  timeout_ms: z.number().int().positive().default(120_000),
})

export const RelayResponse = z.object({
  id: z.string(),
  ok: z.boolean(),
  status: z.number().int().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  duration_ms: z.number().nonnegative().default(0),
  /** Set when the extension itself failed rather than the target. */
  error: z.string().optional(),
  /** AC-EXE-002.1 — the extension observed a login redirect the status alone would not show. */
  redirected_to_login: z.boolean().default(false),
})

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), heartbeat_ms: z.number() }),
  /** ADR-003 — sent inside the 30s window to keep the MV3 service worker alive. */
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('relay.request'), request: RelayRequest }),
])

export type ClientMessage = z.infer<typeof ClientMessage>
export type ServerMessage = z.infer<typeof ServerMessage>
export type RelayRequest = z.infer<typeof RelayRequest>
export type RelayResponse = z.infer<typeof RelayResponse>

/** ADR-003 — douzed pings well inside Chrome's 30-second service-worker idle timeout. */
export const HEARTBEAT_MS = 20_000

/**
 * The extension can only find douzed by probing loopback, so both sides walk this range in order.
 * 8787 is not ours alone — RStudio Server's default is exactly that — and a squatter on it must
 * move the daemon one port along rather than out of the extension's reach entirely.
 */
export const PORT_RANGE = [8787, 8788, 8789, 8790, 8791] as const
export const DEFAULT_PORT = PORT_RANGE[0]

/**
 * REQ-CON-004 — the four failure states a chat client must be able to explain without a
 * terminal. The wording lives here so the CLI, MCP, and relay all say the same thing.
 */
export const RelayErrorCode = z.enum([
  'relay_unreachable',
  'extension_disconnected',
  'session_expired',
  'tool_degraded',
  'confirm_required',
  'rate_limited',
  'timeout',
])
export type RelayErrorCode = z.infer<typeof RelayErrorCode>

export class DouzeError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'DouzeError'
  }

  toResult(): { error: RelayErrorCode; message: string } & Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.detail }
  }
}
