import type { SideEffect } from '@douze/shared'

/**
 * AC-INF-003.2 — the destructive vocabulary.
 *
 * Be honest about what this is: a heuristic over *names*. It sees a method, a path template and a
 * GraphQL operation name, so it can only catch an action that says what it does in its own name.
 * `POST /accounts/{id}/finalize` settles a balance on one API and does nothing irreversible on
 * another, and no word list separates those two. This list will always be incomplete, and every
 * word added to it also costs something (see the false positives below).
 *
 * So the durable backstop is the human reading the review list, not this regex: `classify` produces
 * the FIRST guess, never the last word. A `side_effect` stored on a tool that disagrees with what
 * `classify` would say today is a correction to be preserved, not drift to be re-inferred — nothing
 * here should be read as "inference owns this field".
 *
 * The three things a word here is meant to catch: irreversible money movement (payout, transfer,
 * charge, withdraw, refund), irreversible access change (revoke, deactivate, disable, suspend,
 * rotate, reset), and irreversible data change (delete, remove, purge, wipe, erase, destroy,
 * terminate, cancel).
 *
 * Matched case-insensitively at a WORD START, and camelCase is separated before matching, so
 * `deleteOrder`, `cancellation`, `payouts` and `withdrawal` all match while `preset`, `presets` and
 * `recharge` do not. Left boundary only, because the suffixes are what vary.
 */
export const DESTRUCTIVE_PATTERN =
  /\b(?:delete|remove|purge|wipe|erase|destroy|terminate|cancel|revoke|deactivate|disable|suspend|reset|rotate|refund|charge|payout|transfer|withdraw)/i

const READ_METHODS = new Set(['GET', 'HEAD'])

/** `deactivateAccount` and `WipeWorkspace` have to become two words before `\b` can see them. */
const splitCamelCase = (text: string): string => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2')

/**
 * REQ-INF-003 — classify a candidate's side effect.
 *
 * AC-INF-003.1 gives the base label from the method. AC-INF-003.2 escalates to `destructive` when
 * the path or GraphQL operation name matches the destructive vocabulary. The method is part of the
 * matched text, so `DELETE /orders/{orderId}` escalates without needing "delete" in the path.
 *
 * Escalation applies to writes only: a `GET /orders?status=cancelled` reads cancelled orders, it
 * does not cancel anything, and labelling it destructive would only block bulk approval of a
 * harmless read (AC-INF-003.3). That asymmetry is also what keeps the false-positive cost bounded:
 * a mislabelled write is unreachable from a hosted assistant until a human promotes or demotes it,
 * a mislabelled read would be unreachable from everywhere for no reason at all.
 */
export function classify(input: { method: string; path: string; operation?: string | undefined }): SideEffect {
  const method = input.method.toUpperCase()
  if (READ_METHODS.has(method)) return 'read'
  const subject = splitCamelCase(`${method} ${input.path} ${input.operation ?? ''}`)
  return DESTRUCTIVE_PATTERN.test(subject) ? 'destructive' : 'write'
}
