import type { ConnectCommand, ConnectState } from '../messages.js'

/**
 * WO-015 T-015.4 — #ConnectPage. Ported from the abandoned daemon branch and repointed at the
 * service worker; the copy, the disclosure and the confirm-before-you-break-it flow are that
 * branch's, unchanged. The worker's answers are stubbed until T-015.10 attaches for real, so
 * every action here currently comes back refused and nothing on screen changes.
 */

const CONFIRM = {
  rotate: {
    copy: 'Get a new link? The link you have now stops working straight away, so every assistant you gave it to stops until you paste in the new one.',
    yes: 'Get a new link',
  },
  stop: {
    copy: 'Stop sharing? Every hosted assistant loses access immediately. Douze keeps working in the apps on this computer.',
    yes: 'Stop sharing',
  },
} as const

type Action = keyof typeof CONFIRM

let state: ConnectState = { configured: false, url: '', mcp_url: '', allow_writes: false, connected: false }
let pending: Action | null = null

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const fail = (sentence: string): void => {
  byId('error').textContent = sentence
}
// Never a status code: what the user can do about it, plus whatever the worker could explain.
const because = (error: unknown): string => (error instanceof Error && error.message) || 'Try again in a moment.'

/** The worker answers with the whole state, or with `error` set and nothing changed. */
async function ask(command: ConnectCommand): Promise<ConnectState> {
  const answer = (await chrome.runtime.sendMessage(command)) as ConnectState | undefined
  if (!answer) throw new Error('')
  if (answer.error) throw new Error(answer.error)
  return answer
}

function render(): void {
  byId('setup').hidden = state.configured
  byId('ready').hidden = !state.configured
  byId<HTMLInputElement>('mcp-url').value = state.mcp_url
  byId('relay').textContent = state.url ? `Douze will use the relay at ${state.url}.` : ''
  byId('scope').textContent = state.allow_writes
    ? 'Hosted assistants can look things up and make changes here. Deleting is never possible from a hosted assistant — no flag, no exception.'
    : 'Hosted assistants get read tools only. Changing and deleting are never possible from a hosted assistant — no flag, no exception.'
  byId('link-state').textContent = !state.configured
    ? 'Not shared with anything yet.'
    : state.connected
      ? 'Connected to the relay right now.'
      : 'Not reaching the relay right now. Douze keeps trying on its own; the link stays the same.'
  byId('confirm').hidden = true
  byId('copied').hidden = true
  pending = null
}

byId<HTMLButtonElement>('connect').addEventListener('click', async () => {
  const button = byId<HTMLButtonElement>('connect')
  button.disabled = true
  try {
    fail('')
    state = await ask({ type: 'douze:connect:start' })
    render()
  } catch (error) {
    fail(`Couldn't set up the link. ${because(error)}`)
  }
  button.disabled = false
})

byId('copy').addEventListener('click', async () => {
  const field = byId<HTMLInputElement>('mcp-url')
  const copied = byId('copied')
  copied.hidden = false
  try {
    await navigator.clipboard.writeText(field.value)
    copied.textContent = 'Copied.'
  } catch {
    // No clipboard (an insecure context, or the user refused): select it so the keyboard can.
    field.focus()
    field.select()
    copied.textContent = 'The link is selected — press Ctrl-C, or Cmd-C on a Mac, to copy it.'
  }
})

const confirm = (action: Action): void => {
  pending = action
  byId('confirm-copy').textContent = CONFIRM[action].copy
  byId('confirm-yes').textContent = CONFIRM[action].yes
  byId('confirm').hidden = false
  byId('confirm-yes').focus()
}

byId('rotate').addEventListener('click', () => confirm('rotate'))
byId('stop').addEventListener('click', () => confirm('stop'))
byId('confirm-no').addEventListener('click', () => {
  pending = null
  byId('confirm').hidden = true
})

byId('confirm-yes').addEventListener('click', async () => {
  const action = pending
  byId('confirm').hidden = true
  pending = null
  if (!action) return
  try {
    fail('')
    state = await ask({ type: action === 'rotate' ? 'douze:connect:rotate' : 'douze:connect:stop' })
    render()
  } catch (error) {
    fail(
      action === 'rotate'
        ? `Couldn't get a new link. The one you have still works. ${because(error)}`
        : `Couldn't stop sharing. The link still works. ${because(error)}`,
    )
  }
})

// The page opens on whatever the worker already knows; only the actions above are stubbed.
void ask({ type: 'douze:connect:status' })
  .then((current) => {
    state = current
  })
  .catch(() => {})
  .finally(render)
