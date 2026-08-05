import { ReconError, type RelayErrorCode } from '@recon/shared'

/**
 * REQ-CON-004 — a chat client gives the user no terminal, so every failure has to explain itself
 * inside the message. recond owns the wording for the states it can see; this module owns the
 * states only a client can see (an unreachable daemon) and the rule that binds all of them:
 * AC-CON-004.4 — never retry, never substitute a headless attempt.
 */

/** The shape recond returns on a failed relay: `{ error, message, ...detail }`. */
export interface DaemonErrorBody {
  error?: string
  message?: string
  [key: string]: unknown
}

const RELAY_UNREACHABLE_HINT =
  'The Recon relay (recond) is not running, so no tool can execute. Start it with `recon start` in a terminal, then retry.'

export const relayUnreachable = (cause?: string): ReconError =>
  new ReconError(
    'relay_unreachable',
    cause ? `${RELAY_UNREACHABLE_HINT} (${cause})` : RELAY_UNREACHABLE_HINT,
    {},
  )

const CODES = new Set<string>([
  'relay_unreachable',
  'extension_disconnected',
  'session_expired',
  'tool_degraded',
  'confirm_required',
  'rate_limited',
  'timeout',
])

/**
 * Turns whatever recond returned into a `ReconError`. An unrecognised body still becomes a
 * legible error rather than a stack trace, because the user may only ever see the chat window.
 */
export function fromDaemon(body: DaemonErrorBody, status: number, tool: string): ReconError {
  const { error, message, ...detail } = body
  if (typeof error === 'string' && CODES.has(error)) {
    return new ReconError(error as RelayErrorCode, message ?? error, detail)
  }
  return new ReconError(
    'relay_unreachable',
    `The Recon relay rejected the call to "${tool}" (HTTP ${status}): ${message ?? error ?? 'no reason given'}.`,
    { tool, ...detail },
  )
}

/**
 * The text a client prints. Every branch ends in an instruction the user can act on without a
 * terminal, and none of them suggests a retry the runtime would perform itself.
 */
export function explain(error: ReconError): string {
  const suffix = FOLLOW_UP[error.code]
  return suffix ? `${error.message} ${suffix}` : error.message
}

/**
 * AC-CON-004.4 is a negative requirement, so it is spelled out here rather than left implicit:
 * nothing in this package reissues a failed call or falls back to headless execution.
 */
const FOLLOW_UP: Partial<Record<RelayErrorCode, string>> = {
  relay_unreachable: 'Recon did not retry and did not execute the request any other way.',
  extension_disconnected: 'Recon did not retry and did not execute the request without the browser.',
  session_expired: 'Recon did not retry, so no further request was sent to the target.',
}
