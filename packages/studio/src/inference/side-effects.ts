import type { SideEffect } from '@recon/shared'

/** AC-INF-003.2 — the destructive vocabulary. Matched case-insensitively, substring, not word. */
export const DESTRUCTIVE_PATTERN = /delete|remove|purge|cancel|refund|revoke/i

const READ_METHODS = new Set(['GET', 'HEAD'])

/**
 * REQ-INF-003 — classify a candidate's side effect.
 *
 * AC-INF-003.1 gives the base label from the method. AC-INF-003.2 escalates to `destructive` when
 * the path or GraphQL operation name matches the destructive vocabulary. The method is part of the
 * matched text, so `DELETE /orders/{orderId}` escalates without needing "delete" in the path.
 *
 * Escalation applies to writes only: a `GET /orders?status=cancelled` reads cancelled orders, it
 * does not cancel anything, and labelling it destructive would only block bulk approval of a
 * harmless read (AC-INF-003.3).
 */
export function classify(input: { method: string; path: string; operation?: string | undefined }): SideEffect {
  const method = input.method.toUpperCase()
  if (READ_METHODS.has(method)) return 'read'
  const subject = `${method} ${input.path} ${input.operation ?? ''}`
  return DESTRUCTIVE_PATTERN.test(subject) ? 'destructive' : 'write'
}
