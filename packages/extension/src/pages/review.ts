import type { CandidateView } from '@douze/studio/browser'
import type { ReviewCommand, ReviewSaved, ReviewState } from '../messages.js'

/**
 * WO-015 T-015.4 — #ReviewApp as an extension page. Studio's inline script, typed and pointed at
 * the service worker instead of douzed's `/api/review/*`: no token in the URL, no link to expire,
 * no daemon to be down. Skills are grouped by consequence; technical evidence stays behind one
 * disclosure. Every user-supplied string reaches the DOM through `textContent`.
 */

const GROUPS = {
  read: { title: 'Look things up', detail: 'Read-only.' },
  write: { title: 'Make changes', detail: 'Creates or updates data.' },
  destructive: { title: 'Remove things', detail: 'Always asks first.' },
} as const

const WARNINGS: ['sparse' | 'derived_name' | 'unverified', string][] = [
  ['sparse', 'Only seen once'],
  ['derived_name', 'Name is a guess'],
  ['unverified', 'Not checked yet'],
]

/** The session is named in the URL rather than in a token: an extension page needs no secret. */
const SESSION = new URLSearchParams(location.search).get('session') ?? ''

const SAVE_FAILED = "Couldn't save that. Nothing has changed — try again."

let state: ReviewState | null = null
let seeded = false
const chosen = new Set<string>()

const el = (tag: string, props: Record<string, unknown> = {}, children: (Node | string)[] = []): HTMLElement => {
  const node = Object.assign(document.createElement(tag), props)
  for (const child of children) node.append(child)
  return node
}
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const fail = (sentence: string): void => {
  byId('error').textContent = sentence
}

/** Every worker answer carries `error` when it could not do the thing; nothing else is thrown. */
async function send<T>(command: ReviewCommand): Promise<T> {
  const answer = (await chrome.runtime.sendMessage(command)) as T & { error?: string }
  if (answer?.error) throw new Error(answer.error)
  return answer
}

function editable(
  tag: string,
  candidate: CandidateView,
  field: 'name' | 'description',
  className: string,
): HTMLElement {
  const node = el(tag, { className, textContent: candidate[field], contentEditable: 'plaintext-only' })
  node.setAttribute('aria-label', field === 'name' ? 'Short name for this skill' : 'What this skill does')
  node.addEventListener('blur', async () => {
    const value = node.textContent?.trim() ?? ''
    if (value === candidate[field] || value === '') {
      node.textContent = candidate[field]
      return
    }
    try {
      await send({ type: 'douze:review:edit', sessionId: SESSION, name: candidate.name, field, value })
      fail('')
      await load()
    } catch {
      node.textContent = candidate[field]
      fail(SAVE_FAILED)
    }
  })
  return node
}

function item(candidate: CandidateView): HTMLElement {
  const consequence = el('p', {
    className: 'consequence',
    textContent:
      candidate.side_effect === 'destructive' ? 'Removes data. Asks first.' : 'Changes your account.',
    hidden: candidate.side_effect === 'read',
  })
  const box = el('input', { type: 'checkbox', checked: chosen.has(candidate.name) }) as HTMLInputElement
  box.setAttribute('aria-label', `Use skill: ${candidate.description}`)
  box.addEventListener('change', () => {
    if (box.checked) chosen.add(candidate.name)
    else chosen.delete(candidate.name)
    syncButton()
  })
  const seen = candidate.observations === 1 ? 'Seen once' : `Seen ${candidate.observations} times`
  // Verbatim. Rewriting it here produced "Fetches the v1." — the from/by strip ate the object of
  // the sentence — and the words shown stopped matching the words the user can edit below.
  const summary = candidate.description
  const parts: Node[] = [
    el('div', { className: 'head' }, [
      el('label', { className: 'toggle' }, [box, el('span', { className: 'sr-only', textContent: 'Use this skill' })]),
      el('div', { className: 'skill-copy' }, [el('p', { className: 'desc', textContent: summary }), consequence]),
    ]),
  ]
  const detailParts: Node[] = [
    editable('p', candidate, 'description', 'full-desc'),
    el('p', { className: 'meta' }, [
      el('span', { textContent: seen }),
      editable('code', candidate, 'name', 'name'),
    ]),
  ]
  for (const [flag, sentence] of WARNINGS) {
    if (candidate.flags[flag]) detailParts.push(el('p', { className: 'warn', textContent: sentence }))
  }
  detailParts.push(
    el('p', { className: 'warn', textContent: `${candidate.request.method} ${candidate.request.path}` }),
    el('pre', { textContent: JSON.stringify(candidate.sample, null, 2) }),
    el('pre', { textContent: ['Input schema', JSON.stringify(candidate.request.input_schema, null, 2)].join('\n') }),
  )
  parts.push(el('details', {}, [el('summary', { textContent: 'Details' }), ...detailParts]))
  return el('li', { className: 'skill' }, parts)
}

function group(kind: keyof typeof GROUPS, candidates: CandidateView[]): HTMLElement {
  const copy = GROUPS[kind]
  return el('section', { className: `group ${kind}` }, [
    el('div', { className: 'group-heading' }, [
      el('h2', { textContent: `${copy.title} ` }, [
        el('span', { className: 'group-count', textContent: `(${candidates.length})` }),
      ]),
      el('p', { textContent: copy.detail }),
    ]),
    el('ul', {}, candidates.map(item)),
  ])
}

function syncButton(): void {
  const count = chosen.size
  const total = state?.candidates.length ?? 0
  byId('count').textContent = `${count} of ${total} selected`
  const go = byId<HTMLButtonElement>('go')
  go.disabled = count === 0
  go.textContent = count === 0 ? 'Choose a skill' : `Keep ${count} skill${count === 1 ? '' : 's'}`
  byId<HTMLButtonElement>('all').disabled = count === total
  byId<HTMLButtonElement>('none').disabled = count === 0
}

function render(): void {
  if (!state) return
  byId('eyebrow').textContent = `Douze · ${state.site}`
  byId('title').textContent = 'Choose what to keep'
  byId('sub').textContent = 'Everything that only reads is selected. Turn on anything that makes changes.'
  const groups = byId('groups')
  groups.textContent = ''
  for (const kind of ['read', 'write', 'destructive'] as const) {
    const candidates = state.candidates.filter((candidate) => candidate.side_effect === kind)
    if (candidates.length > 0) groups.append(group(kind, candidates))
  }
  byId('toolbar').hidden = false
  byId('actions').hidden = false
  byId('after').hidden = true
  syncButton()
}

async function load(): Promise<void> {
  state = await send<ReviewState>({ type: 'douze:review:load', sessionId: SESSION })
  const names = new Set(state.candidates.map((candidate) => candidate.name))
  for (const name of chosen) if (!names.has(name)) chosen.delete(name)
  // Seed once so an edit/reload does not undo a choice the user already made.
  //
  // Reads only. Pre-selecting everything meant one click on the primary button approved a delete
  // the user had never read — the same thing AC-REC-002.3 refuses to do through the bulk API.
  if (!seeded) {
    seeded = true
    for (const candidate of state.candidates) if (candidate.bulk_approvable) chosen.add(candidate.name)
  }
  render()
}

function done(count: number): void {
  byId('title').textContent = 'All set'
  byId('sub').textContent = `Douze is ready on ${state?.site ?? 'this site'}.`
  byId('groups').textContent = ''
  byId('toolbar').hidden = true
  byId('actions').hidden = true
  byId('after').hidden = false
  byId('success-copy').textContent = `${count} skill${count === 1 ? '' : 's'} ready.`
}

byId('all').addEventListener('click', () => {
  for (const candidate of state?.candidates ?? []) chosen.add(candidate.name)
  render()
})

byId('none').addEventListener('click', () => {
  chosen.clear()
  render()
})

byId('go').addEventListener('click', async () => {
  const all = (state?.candidates ?? []).map((candidate) => candidate.name)
  try {
    fail('')
    await send({ type: 'douze:review:enable', sessionId: SESSION, names: all.filter((name) => chosen.has(name)) })
    const off = all.filter((name) => !chosen.has(name))
    if (off.length > 0) await send({ type: 'douze:review:disable', sessionId: SESSION, names: off })
    const report = await send<ReviewSaved>({ type: 'douze:review:save', sessionId: SESSION })
    done(report.tools.length)
  } catch {
    fail(SAVE_FAILED)
  }
})

byId('back').addEventListener('click', () => {
  fail('')
  render()
})

void load().catch(() =>
  fail(
    "Couldn't load what this site can do. Try reloading this page. " +
      "If that doesn't help, click the Douze button in Chrome and record the site again.",
  ),
)
