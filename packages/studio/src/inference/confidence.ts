import type { SideEffect } from '@douze/shared'

/** Observations past this point add no further confidence. */
const SATURATION = 5

const WEIGHTS = { observations: 0.5, stability: 0.3, sideEffect: 0.2 }

/** AC-INF-002.3 — a single observation can never produce a confident tool. */
export const SPARSE_CEILING = 0.4

/**
 * REQ-INF-002 — confidence from observation count, schema stability, and side-effect certainty.
 *
 * Side-effect certainty is highest where the classification is unambiguous: a GET is a read and a
 * destructive-vocabulary match is deliberate, while a bare POST could be either.
 */
export function score(input: { observations: number; stability: number; sideEffect: SideEffect }): number {
  const observations = Math.min(1, input.observations / SATURATION)
  const certainty = input.sideEffect === 'write' ? 0.85 : 1
  const raw =
    WEIGHTS.observations * observations +
    WEIGHTS.stability * clamp(input.stability) +
    WEIGHTS.sideEffect * certainty
  const capped = input.observations <= 1 ? Math.min(raw, SPARSE_CEILING) : raw
  return Math.round(clamp(capped) * 100) / 100
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value))
