import type { SideEffect } from '@recon/shared'
import { plural, singular, snake } from '../inference/templating.js'

/**
 * AC-INF-006.1 — verb-object snake_case from method, path, annotation, and UI provenance.
 * AC-CAP-007.3 — the annotation note outranks the UI provenance as evidence, because a button
 * label describes the control while a note describes the intent.
 */
export interface NameInput {
  method: string
  path: string
  sideEffect: SideEffect
  /** True when the path carries a template parameter, i.e. the call addresses one record. */
  addressed: boolean
  annotation?: string | undefined
  provenance?: string | undefined
  graphqlOperation?: string | undefined
}

/** Intent verbs worth preferring over the method's generic verb when the evidence names one. */
const VERB_HINTS = [
  'transition',
  'archive',
  'unarchive',
  'publish',
  'unpublish',
  'cancel',
  'refund',
  'revoke',
  'approve',
  'reject',
  'assign',
  'unassign',
  'close',
  'reopen',
  'duplicate',
  'export',
  'import',
  'restore',
  'send',
  'invite',
  'upload',
  'retry',
  'resend',
  'suspend',
  'activate',
  'deactivate',
]

const METHOD_VERBS: Record<string, string> = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' }

export function nameCandidate(input: NameInput): string {
  if (input.graphqlOperation !== undefined) return snake(input.graphqlOperation)

  const object = objectFrom(input.path)
  const verb = verbFrom(input)
  const noun = verb === 'list' ? plural(object) : singular(object)
  return snake(verb === singular(noun) ? noun : `${verb}_${noun}`)
}

/**
 * The resource the tool acts on. `POST /orders/{id}/refund` acts on an order, not on a "refund":
 * a trailing action segment is the verb, so the noun is the resource that precedes it.
 */
export function objectFrom(path: string): string {
  const statics = path.split('/').filter((s) => s.length > 0 && !s.startsWith('{'))
  const resource = [...statics].reverse().find((segment) => !isActionSegment(segment) && !/\d/.test(segment))
  return resource ?? statics.at(-1) ?? 'resource'
}

const isActionSegment = (segment: string): boolean => VERB_HINTS.includes(segment.toLowerCase())

function verbFrom(input: NameInput): string {
  const method = input.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return input.addressed ? 'get' : 'list'
  // A trailing action segment is the app naming the operation itself — the strongest evidence
  // there is. Then the note ("transitions an issue"), then the button label ("Save"), which says
  // nothing, then the method's generic verb.
  const action = path0(input.path)
  const hint = hintVerb(input.annotation) ?? hintVerb(input.provenance)
  return action ?? hint ?? METHOD_VERBS[method] ?? 'call'
}

function path0(path: string): string | undefined {
  const statics = path.split('/').filter((s) => s.length > 0 && !s.startsWith('{'))
  const last = statics.at(-1)
  return last !== undefined && isActionSegment(last) ? last.toLowerCase() : undefined
}

function hintVerb(evidence: string | undefined): string | undefined {
  if (evidence === undefined) return undefined
  const text = evidence.toLowerCase()
  return VERB_HINTS.find((verb) => text.includes(verb))
}

/**
 * AC-INF-006.3 — two candidates that would share a name are disambiguated from the parameters
 * that distinguish them, falling back to an ordinal only when nothing distinguishes them.
 */
export function disambiguate(entries: { name: string; parameters: string[] }[]): string[] {
  const names = entries.map((e) => e.name)
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)

  const taken = new Set<string>()
  return entries.map((entry, index) => {
    if ((counts.get(entry.name) ?? 0) <= 1) {
      taken.add(entry.name)
      return entry.name
    }
    const others = entries.filter((_, i) => i !== index && entries[i]?.name === entry.name)
    const shared = new Set(others.flatMap((o) => o.parameters))
    const distinguishing = entry.parameters.filter((p) => !shared.has(p)).sort()
    const suffix = distinguishing[0]
    const candidate = suffix !== undefined ? `${entry.name}_by_${snake(suffix)}` : `${entry.name}_${index + 1}`
    let unique = candidate
    let n = 2
    while (taken.has(unique)) unique = `${candidate}_${n++}`
    taken.add(unique)
    return unique
  })
}
