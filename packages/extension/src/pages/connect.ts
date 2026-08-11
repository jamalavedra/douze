import type { ConnectCommand, ConnectState } from '../messages.js'

/**
 * WO-015 T-015.4/10 — #ConnectPage, and the whole reason the extension-only port exists: somebody
 * with no terminal clicks the Douze button and leaves here with a link to paste into ChatGPT.
 * The copy, the disclosure and the confirm-before-you-break-it flow are the abandoned daemon
 * branch's, unchanged; T-015.10 added the controls the terminal used to hold — the write opt-in,
 * the secret-gate exemptions, and the pairing code a local bridge prints.
 *
 * Everything on screen is read out of the worker's answer. Nothing is assumed and nothing is
 * guessed: a state the worker does not know is said to be unknown rather than drawn as an
 * encouraging default.
 */

/**
 * Everything that breaks something somebody is already using: what the second click does, the
 * command it sends, and what to say if it could not be done. One shape for all three, because the
 * page's whole confirm flow is "say what it costs, then do exactly that or nothing".
 */
const CONFIRM = {
  rotate: {
    copy: 'Get a new link? The link you have now stops working straight away, so every assistant you gave it to stops until you paste in the new one.',
    yes: 'Get a new link',
    command: { type: 'douze:connect:rotate' },
    failed: "Couldn't get a new link. The one you have still works.",
  },
  stop: {
    copy: 'Stop sharing? Every hosted assistant loses access immediately. Douze keeps working in the apps on this computer.',
    yes: 'Stop sharing',
    command: { type: 'douze:connect:stop' },
    failed: "Couldn't stop sharing. The link still works.",
  },
  unpair: {
    copy: 'Unpair the app on this computer? It loses every tool straight away, the ones that delete included. Douze forgets the pairing, so starting that app again means typing in the new code it prints.',
    yes: 'Unpair',
    command: { type: 'douze:connect:unpair' },
    failed: "Couldn't unpair. The app on this computer still has every tool.",
  },
} as const satisfies Record<string, { copy: string; yes: string; command: ConnectCommand; failed: string }>

type Action = keyof typeof CONFIRM
type Trust = 'local' | 'remote'

/** How each trust level is named to the reader — never "local" and "remote", which are our words. */
const WHO: Record<Trust, string> = {
  local: 'apps on this computer',
  remote: 'hosted assistants',
}

const BRIDGE_SENTENCE: Record<ConnectState['bridge'], string> = {
  unpaired: 'No app on this computer is paired with Douze.',
  trying: 'Douze has your code and is trying to pair. This can take up to 30 seconds.',
  paired: 'An app on this computer is paired and may use every tool, including the ones that delete.',
  refused: 'The last code was refused. Restart the app and type the new code it prints.',
}

let state: ConnectState = {
  configured: false,
  url: '',
  mcp_url: '',
  allow_writes: false,
  connected: false,
  tools: [],
  exposed: { local: [], remote: [] },
  bridge: 'unpaired',
}
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

/**
 * Runs one command and re-renders from what came back, or leaves the screen exactly as it was.
 *
 * A `warning` is not a failure and not a success either — `stop` clears the pairing even when the
 * relay could not be told — so it survives the re-render instead of being swallowed by it.
 */
async function run(command: ConnectCommand, whenItFails: (reason: string) => string): Promise<void> {
  try {
    fail('')
    state = await ask(command)
    render()
    if (state.warning) fail(state.warning)
  } catch (error) {
    fail(whenItFails(because(error)))
  }
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function render(): void {
  byId('setup').hidden = state.configured
  byId('ready').hidden = !state.configured
  byId<HTMLInputElement>('mcp-url').value = state.mcp_url
  byId<HTMLInputElement>('relay-url').value = state.url
  byId('scope').textContent = state.allow_writes
    ? 'Hosted assistants can look things up and make changes here. Deleting is never possible from a hosted assistant — no flag, no exception.'
    : 'Hosted assistants get read tools only. Changing and deleting are never possible from a hosted assistant — no flag, no exception.'
  byId('writes-state').textContent = state.allow_writes
    ? 'Looking things up, and making changes — creating and updating things on the sites you recorded.'
    : 'Looking things up. Nothing a hosted assistant sends can change anything.'
  byId('writes').textContent = state.allow_writes ? 'Go back to read-only' : 'Allow changes too'
  byId('link-state').textContent = !state.configured
    ? 'Not shared with anything yet.'
    : state.connected
      ? 'Shared, and Douze has a live connection right now.'
      : 'Shared, but Douze has no connection at the moment. It keeps trying on its own; the link stays the same.'
  byId('bridge-state').textContent = BRIDGE_SENTENCE[state.bridge]
  // Nothing to withdraw when nothing was ever granted. `refused` still has a stored block to clear.
  byId<HTMLButtonElement>('unpair').disabled = state.bridge === 'unpaired'
  renderExposed()
  byId('confirm').hidden = true
  byId('copied').hidden = true
  pending = null
}

/** The two exemption lists, drawn separately because they mean two different things. */
function renderExposed(): void {
  for (const trust of ['local', 'remote'] as const) {
    const list = byId<HTMLUListElement>(`exposed-${trust}`)
    const tools = state.exposed[trust]
    if (tools.length === 0) {
      const empty = document.createElement('li')
      empty.textContent = 'No tool is allowed. Every answer goes through the check.'
      list.replaceChildren(empty)
      continue
    }
    list.replaceChildren(...tools.map((tool) => exemption(trust, tool)))
  }

  const select = byId<HTMLSelectElement>('expose-tool')
  select.replaceChildren(
    ...state.tools.map((tool) => {
      const option = document.createElement('option')
      option.value = tool
      option.textContent = tool
      return option
    }),
  )
  // No tools yet is a real state and says so, rather than offering an empty box that does nothing.
  const none = state.tools.length === 0
  select.disabled = none
  select.hidden = none
  byId('expose-empty').hidden = !none
  byId<HTMLButtonElement>('expose-local').disabled = none
  byId<HTMLButtonElement>('expose-remote').disabled = none
}

function exemption(trust: Trust, tool: string): HTMLLIElement {
  const item = document.createElement('li')
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = tool
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'quiet'
  remove.textContent = 'Stop allowing'
  remove.setAttribute('aria-label', `Stop allowing ${tool} for ${WHO[trust]}`)
  remove.addEventListener('click', () => {
    void run({ type: 'douze:connect:expose', trust, tool, allow: false }, (reason) => `Couldn't change that. ${reason}`)
  })
  item.append(name, ' ', remove)
  return item
}

byId<HTMLButtonElement>('connect').addEventListener('click', async () => {
  const button = byId<HTMLButtonElement>('connect')
  const typed = byId<HTMLInputElement>('relay-url').value.trim() || state.url
  const origin = originOf(typed)
  if (!origin) {
    return fail(`"${typed}" is not a web address. It should look like https://douze.example.com.`)
  }
  // Disabled before anything is awaited, permission prompt included: a second click while that
  // prompt is up would register a second endpoint on the relay that nothing here has the token to
  // retire. Disabling a button does not spend the user gesture the request below needs.
  button.disabled = true
  try {
    // A worker `fetch` to a host Chrome has not granted fails as an opaque network error, so the
    // permission is asked for here, in the one context that has a gesture to spend on it.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] })
    if (!granted) {
      return fail(`Douze needs Chrome's permission to reach ${origin}. Nothing has been shared.`)
    }
    await run({ type: 'douze:connect:start', url: typed }, (reason) => `Couldn't set up the link. ${reason}`)
  } finally {
    button.disabled = false
  }
  return undefined
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

byId('writes').addEventListener('click', () => {
  void run(
    { type: 'douze:connect:writes', allow: !state.allow_writes },
    (reason) => `Couldn't change what hosted assistants may do. Nothing changed. ${reason}`,
  )
})

for (const trust of ['local', 'remote'] as const) {
  byId(`expose-${trust}`).addEventListener('click', () => {
    const tool = byId<HTMLSelectElement>('expose-tool').value
    if (!tool) return
    void run({ type: 'douze:connect:expose', trust, tool, allow: true }, (reason) => `Couldn't allow it. ${reason}`)
  })
}

byId('pair').addEventListener('click', () => {
  const field = byId<HTMLInputElement>('pair-code')
  const code = field.value.trim()
  if (!code) return fail('Type the code the app printed, then press Pair.')
  field.value = ''
  void run({ type: 'douze:connect:pair', code }, (reason) => `Couldn't use that code. ${reason}`)
  return undefined
})

const confirm = (action: Action): void => {
  pending = action
  byId('confirm-copy').textContent = CONFIRM[action].copy
  byId('confirm-yes').textContent = CONFIRM[action].yes
  byId('confirm').hidden = false
  byId('confirm-yes').focus()
}

for (const action of ['rotate', 'stop', 'unpair'] as const) {
  byId(action).addEventListener('click', () => confirm(action))
}
byId('confirm-no').addEventListener('click', () => {
  pending = null
  byId('confirm').hidden = true
})

byId('confirm-yes').addEventListener('click', () => {
  const action = pending
  byId('confirm').hidden = true
  pending = null
  if (!action) return
  void run(CONFIRM[action].command, (reason) => `${CONFIRM[action].failed} ${reason}`)
})

// The page opens on whatever the worker already knows.
void ask({ type: 'douze:connect:status' })
  .then((current) => {
    state = current
  })
  .catch(() => {})
  .finally(render)
