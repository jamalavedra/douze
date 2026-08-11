import { z } from 'zod'
import { CredentialSource } from './recipe.js'

/**
 * WO-015 T-015.13 — the extension no longer speaks to a local daemon, so the capture protocol
 * (`ClientMessage`/`ServerMessage`, `exchange.*`) went with douzed: capture is a call into the
 * extension's own store now, not a frame on a socket. What is left is the shape of one relayed
 * HTTP call, which the extension still executes from an Executor Tab, and the vocabulary the
 * attachment protocol (`@douze/mcp-host`) and the relay share.
 */

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
  /** The origin whose tab runs the request; absent means the target's own (see AuthDescriptor). */
  execute_origin: z.string().optional(),
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

export type RelayRequest = z.infer<typeof RelayRequest>
export type RelayResponse = z.infer<typeof RelayResponse>

/** ADR-003 — a host pings well inside Chrome's 30-second service-worker idle timeout. */
export const HEARTBEAT_MS = 20_000

/**
 * REQ-CON-004 — the four failure states a chat client must be able to explain without a
 * terminal. The wording lives here so the extension, both pipes, and the relay all say the same
 * thing.
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

/**
 * WO-014 — the body of `POST /register`, the one relay route anyone on the internet can reach
 * unauthenticated. `daemon_version` reaches a relay log line, so it is held to a character set
 * that cannot carry a newline and forge an entry of its own. `+` is in it because semver build
 * metadata (`0.1.0+abc`) is a version a client legitimately reports.
 *
 * WO-015 T-015.13 — the opaque `mcp.message` frames this file used to carry alongside it are
 * gone with the daemon. `@douze/mcp-host` owns the attachment protocol that replaced them, and
 * owns it in one place precisely so the relay and the bridge cannot drift apart.
 */
export const RemoteRegistration = z.object({
  daemon_version: z
    .string()
    .regex(/^[\w.+-]{1,32}$/)
    .optional(),
  bearer_token: z.string().max(512).optional(),
})
export type RemoteRegistration = z.infer<typeof RemoteRegistration>

/** WO-014 — concurrent platform sessions the relay serves per endpoint before refusing another. */
export const REMOTE_MAX_SESSIONS = 4

/** WO-014 — the relay drops a platform session idle for this long. */
export const REMOTE_SESSION_IDLE_MS = 600_000
