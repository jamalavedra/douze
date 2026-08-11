import type { CandidateView, EditableField } from '@douze/studio/browser'
import type { RecipeStore } from './recipes.js'
import type { CaptureStore } from './store.js'

/**
 * !!! STUB — WO-015 T-015.4 wrote this against a signature it was given, not an implementation.
 *
 * The real #ReviewSession belongs to the parallel T-015 lane that owns `store.ts` and
 * `recipes.ts`; this file exists only so the review page and its routing in `background.ts`
 * typecheck and build in isolation. Every method throws. Delete this file wholesale when the
 * real one lands — do not merge the two.
 */

export interface ReviewStores {
  captures: CaptureStore
  recipes: RecipeStore
}

const unimplemented = (): never => {
  throw new Error('ReviewSession is not implemented yet (WO-015 T-015.1/T-015.2 lane)')
}

export class ReviewSession {
  /** Infers the capture's candidates and holds them until `save()` persists the approved ones. */
  static open(_sessionId: string, _stores: ReviewStores): Promise<ReviewSession> {
    return unimplemented()
  }

  /** The site the tools belong to, as the user knows it — a hostname, not a base URL. */
  site(): string {
    return unimplemented()
  }

  /** Kebab-case recipe name derived from the session name. */
  recipeName(): string {
    return unimplemented()
  }

  candidates(): CandidateView[] {
    return unimplemented()
  }

  edit(_name: string, _field: EditableField, _value: unknown): void {
    unimplemented()
  }

  approve(_names: string[]): void {
    unimplemented()
  }

  unapprove(_names: string[]): void {
    unimplemented()
  }

  /** AC-REC-002.3 — the bulk path, which reaches `read` candidates only. */
  approveReads(): void {
    unimplemented()
  }

  save(): Promise<unknown> {
    return unimplemented()
  }
}
