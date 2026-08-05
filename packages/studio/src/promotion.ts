import { CONFIRM_PARAM } from '@recon/shared'
import type { Candidate, JsonSchema } from './types.js'

export interface BulkResult {
  approved: string[]
  /** Names left unapproved because they need individual review (AC-INF-003.3). */
  skipped: string[]
}

/**
 * AC-REC-002.3 / AC-INF-003.3 — bulk approval reaches `read` candidates only. A write or a
 * destructive tool has to be looked at one at a time; that is the whole point of review.
 */
export function approveReads(candidates: Candidate[]): BulkResult {
  const result: BulkResult = { approved: [], skipped: [] }
  for (const candidate of candidates) {
    if (candidate.tool.side_effect === 'read') {
      approve(candidate)
      result.approved.push(candidate.tool.name)
    } else {
      result.skipped.push(candidate.tool.name)
    }
  }
  return result
}

/**
 * AC-REC-002.4 — approving a destructive candidate injects a required `confirm` parameter.
 * `packages/shared/src/recipe.ts` validates this and refuses to serialize a recipe without it,
 * so this is the one place that can satisfy that constraint.
 */
export function approve(candidate: Candidate): Candidate {
  candidate.tool.approved = true
  if (candidate.tool.side_effect === 'destructive') {
    candidate.tool.request.input_schema = injectConfirm(candidate.tool.request.input_schema)
  }
  return candidate
}

export function unapprove(candidate: Candidate): Candidate {
  candidate.tool.approved = false
  return candidate
}

export function injectConfirm(schema: JsonSchema): JsonSchema {
  const properties = { ...(schema['properties'] as Record<string, unknown> | undefined), confirm: CONFIRM_PARAM }
  const required = new Set((schema['required'] as string[] | undefined) ?? [])
  required.add('confirm')
  return { ...schema, type: 'object', properties, required: [...required].sort() }
}

/** AC-REC-002.5 — the runtime only ever sees approved candidates. */
export const approvedTools = (candidates: Candidate[]) => candidates.filter((c) => c.tool.approved).map((c) => c.tool)
