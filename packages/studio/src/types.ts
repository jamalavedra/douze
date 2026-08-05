import type { Exchange, Tool, UiProvenance } from '@recon/shared'

/** JSON Schema documents are plain objects; nothing here needs a schema-of-schemas. */
export type JsonSchema = Record<string, unknown>

/**
 * AC-REC-002.1 — everything the review UI must show next to a candidate. Every candidate is
 * traceable to at least one exchange (`exchange_ids` is never empty).
 */
export interface Evidence {
  exchange_ids: string[]
  /** Already redacted: it comes straight out of #CaptureStore, which redacts on write. */
  sample: Exchange
  provenance?: UiProvenance
  annotation?: string
}

/** An inferred, not-yet-approved operation. `tool.approved` stays false until promotion. */
export interface Candidate {
  tool: Tool
  evidence: Evidence
}
